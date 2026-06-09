$(function() {
    var graph;
    var graph_force_timeout;
    var graph_force_interval;

    var GAMES = {
        factorio: {
            label: 'Factorio (Space Age)',
            file: './data/factorio.json',
            // id -> { name, speed, icon } for the active game's
            // production buildings. Tooltip skips the section when null.
            buildings: './data/factorio-buildings.json',
            // Pre-select this item on first load (no URL / localStorage
            // state). Lets a brand-new visitor see a populated tree
            // immediately instead of an empty page.
            default_item: 'electronic circuit',
            // Sprite-sheet for the picker / tooltip icons. natural_w is
            // the sheet's native pixel width (square); cells are always
            // 64px. Set on body as --sprite-url / --sprite-natural-w so
            // the CSS picks them up.
            sprite: './data/sources/factoriolab-factorio/icons.webp',
            sprite_natural_w: 1978,
        },
        dyson: {
            label: 'Dyson Sphere Program',
            file: './data/dyson.json',
            buildings: './data/dyson-buildings.json',
            default_item: 'magnetic coil',
            sprite: './data/sources/factoriolab-dsp/icons.webp',
            sprite_natural_w: 1472,
        },
    };
    var DEFAULT_GAME = 'factorio';
    var current_game = DEFAULT_GAME;

    var items = {};
    // Items the user has "collapsed" via the graph: treated as raw materials
    // from that point on — counted under "Raw" in the totals, rendered as
    // raw-colored leaves in the graph, no recursion into their ingredients.
    // Persists across item selections within a game; resets on game change.
    var collapsed = new Set();
    // Recipe override per item — itemName -> recipeId. Set when the user
    // picks an alternative from the Recipe Picker panel; clear (or absent)
    // means use the inline default recipe on each entry. active_recipe()
    // resolves this at every lookup. Resets on game change.
    var recipe_overrides = new Map();
    var game_select = $("#game_select");
    var item_select = $("#item_select");
    var per_sec_input = $("#items_per_sec");
    var recipe_picker_panel = $("#recipe_picker");
    var graph_display = $("#graph");
    var node_tooltip = $("#node_tooltip");
    // Last-computed totals from calculate_total_materials. Stored at module
    // scope so the node-hover tooltip can read counts without recomputing.
    var total_materials = null;
    // id -> { name, speed } for the active game's production buildings.
    // Loaded from GAMES[g].buildings if present; null otherwise. The
    // tooltip computes "N buildings needed = production_units / speed"
    // for each entry in a recipe's producers[] array.
    var buildings = null;

    // Picker (in-game-style item browser). Available when the active game's
    // data carries layout fields (category/row/col/icon on each entry) —
    // today that's DSP only. Factorio data has no icons; picker_btn stays
    // hidden and the dropdown is the only chooser.
    var current_selection_btn = $("#current_selection");
    var picker_overlay = $("#picker_overlay");
    var picker_panel_el = $(".picker-panel");
    var picker_tabs_el = $("#picker_tabs");
    var picker_grid_el = $("#picker_grid");
    var picker_side_el = $("#picker_side");
    var picker_active_tab = null;
    // Current grid-tile size (px). 64 = sprite native cell size; smaller
    // when the viewport can't fit the widest row at full size. Recomputed
    // each open and on window resize while the picker is open. JS uses it
    // to scale background-position; CSS uses --icon-size for box dims and
    // background-size (sprite scale).
    var picker_icon_size = 64;

    function show_item_details() {
        var item = items[item_select.val()];
        // Everything below reads from the latest totals. The materials
        // panel is gone; the hover tooltip + recipe-picker panel are now
        // how per-item info is surfaced.
        total_materials = calculate_total_materials(item);
        render_recipe_picker();
        render_graph();
    }

    // Recipe-picker left panel: for each item in the current tree that has
    // alternative recipes, show a radio group. Selecting a non-default
    // alternative writes into recipe_overrides and re-renders. The default
    // pick clears any override.
    function render_recipe_picker() {
        recipe_picker_panel.empty();
        // .panel-header is the shared flex row used by the graph panel
        // too — same min-height so the underlines line up across panels.
        recipe_picker_panel.append('<div class="panel-header"><h2>Production Choices</h2></div>');

        // Collect items in the current tree — built or raw side of the
        // latest totals. Anything not in the tree right now doesn't show up
        // even if it has alternatives elsewhere in the game.
        var tree_items = new Set();
        if (total_materials) {
            for (var k in total_materials.built) tree_items.add(k);
            for (var k in total_materials.raw) tree_items.add(k);
        }

        var any_choices = false;
        // Stable order: walk dyson.json's natural (alphabetic) iteration
        // and filter to tree_items, so the panel doesn't reshuffle as you
        // toggle alternatives.
        for (var name in items) {
            if (!tree_items.has(name)) continue;
            var entry = items[name];
            if (!entry.alternatives || entry.alternatives.length === 0) continue;
            any_choices = true;
            var card = $('<div class="rp-item"></div>')
                .append($('<div class="rp-item-name"></div>').text(name));
            // Hover the card to get the same per-second / buildings /
            // ingredients tooltip the graph node would show. Captured
            // via a closure so the handler knows which item this card
            // belongs to. mouseleave hides; we don't track mousemove,
            // which matches the graph (sigma fires overNode once on
            // enter — the tooltip stays pinned where it first appeared).
            (function(itemName) {
                card.on('mouseenter', function(e) {
                    show_node_tooltip(itemName, e.clientX, e.clientY);
                }).on('mouseleave', hide_node_tooltip);
            })(name);
            // Default recipe option — uses the inline fields on `entry`.
            var override = recipe_overrides.get(name);
            card.append(makeRecipeOption(name, entry, !override, true));
            // Alternative options.
            for (var alt of entry.alternatives) {
                card.append(makeRecipeOption(
                    name, alt, override === alt.recipe, false,
                ));
            }
            recipe_picker_panel.append(card);
        }

        if (!any_choices) {
            recipe_picker_panel.append(
                '<p class="rp-hint">No items in this tree have alternative recipes.</p>'
            );
        }
    }

    function makeRecipeOption(itemName, rec, isSelected, isDefault) {
        // Display values are PER-CRAFT — multiply back the per-output
        // normalization done at load time so the numbers read like an
        // in-game recipe panel ("makes 2 in 1s, uses 2 fire ice").
        var produced = rec.produced || 1;
        var label = $('<label class="rp-option"></label>');
        if (isSelected) label.addClass('selected');
        // Per-option tooltip: hovering this option previews IT (not the
        // currently-active recipe) so the user can compare flow rates /
        // building counts before clicking. Leaving the option resets to
        // the active recipe so the card's name-area state stays sensible;
        // the card-level mouseleave (in render_recipe_picker) handles
        // the final hide when the cursor exits the whole card.
        label.on('mouseenter', function(e) {
            show_node_tooltip(itemName, e.clientX, e.clientY, rec);
        }).on('mouseleave', function(e) {
            show_node_tooltip(itemName, e.clientX, e.clientY);
        });
        var input = $('<input type="radio">')
            .attr('name', 'rp-' + itemName)
            .attr('value', rec.recipe);
        if (isSelected) input.prop('checked', true);
        input.on('change', function() {
            if (!this.checked) return;
            if (isDefault) {
                recipe_overrides.delete(itemName);
            } else {
                recipe_overrides.set(itemName, rec.recipe);
            }
            save_recipe_overrides();
            show_item_details();
        });
        label.append(input);
        var meta = $('<div class="rp-option-meta"></div>');
        // A default option with no recipe is the "mine it raw" path for a
        // dual-nature item (e.g. silicon ore: mined by default, or smelted
        // from stone via the alternative). Label and summarize it as raw
        // instead of letting the recipe id / time render as "undefined" / "0s".
        var is_raw = !rec.recipe;
        meta.append($('<span class="rp-recipe-id"></span>')
            .text(is_raw ? 'raw resource (default)'
                         : rec.recipe + (isDefault ? ' (default)' : '')));
        if (!is_raw) {
            var summary = format_num((rec.time || 0) * produced) + 's'
                + (produced !== 1 ? ' · makes ' + produced : '');
            meta.append($('<span class="rp-recipe-summary"></span>').text(summary));
        }
        var matsLine = $('<div class="rp-mats-line"></div>');
        for (var m in rec.mats) {
            matsLine.append($('<span class="rp-mat"></span>')
                .text(m + ' ×' + format_num(rec.mats[m] * produced)));
        }
        meta.append(matsLine);
        if (rec.byproducts && Object.keys(rec.byproducts).length > 0) {
            var byLine = $('<div class="rp-mats-line rp-byproducts"></div>');
            byLine.append($('<span class="rp-byp-label"></span>').text('byproduct'));
            for (var b in rec.byproducts) {
                byLine.append($('<span class="rp-mat"></span>')
                    .text(b + ' ×' + format_num(rec.byproducts[b] * produced)));
            }
            meta.append(byLine);
        }
        label.append(meta);
        return label;
    }

    function render_graph() {
        var item = items[item_select.val()];
        // Kill the previous instance properly. sigma's force-atlas runs on
        // a timer in the background; without this it keeps ticking against
        // a canvas we've already removed. Cheap cleanup, prevents leaks.
        if (graph) {
            try { graph.killForceAtlas2(); } catch (e) {}
            try { graph.kill(); } catch (e) {}
            graph = null;
        }
        clearTimeout(graph_force_timeout);
        clearInterval(graph_force_interval);

        // Remove dynamic children (previous header + .graph-canvas) but
        // KEEP the static .graph-legend so its open/closed state persists.
        graph_display.children().not('.graph-legend').remove();

        // Header row: title + (conditional) uncollapse + reload buttons.
        // Uses the shared .panel-header class. Reload re-runs render_graph
        // (handy when forceAtlas2 lands a cramped layout — fresh random
        // positions each run via Math.random() in makeNodes). Uncollapse
        // only renders when something IS collapsed; otherwise the button
        // would be misleading.
        var header = $('<div class="panel-header"></div>');
        header.append('<h2>Material Graph</h2>');
        var headerBtns = $('<div class="panel-header-btns"></div>')
            .appendTo(header);
        if (collapsed.size > 0) {
            $('<button class="graph-btn" type="button" title="Uncollapse all nodes">'
                + 'uncollapse (' + collapsed.size + ')</button>')
                .on('click', function() {
                    collapsed.clear();
                    hide_node_tooltip();
                    show_item_details();
                })
                .appendTo(headerBtns);
        }
        $('<button class="graph-btn graph-btn-icon" type="button" title="Re-layout graph">⟳</button>')
            .on('click', render_graph)
            .appendTo(headerBtns);
        graph_display.append(header);

        graph = makeGraph(item);

        // Click a node to toggle "collapsed" — treat it as a raw material
        // (no incoming edges in the graph, counted under Raw in totals,
        // its ingredients no longer traced). Clicking again uncollapses.
        // The root (selected item) is the calculation target so collapsing
        // it is meaningless — silently ignored.
        graph.bind('clickNode', function(e) {
            var nodeId = e.data.node.id;
            if (nodeId === item.name) return;
            if (collapsed.has(nodeId)) {
                collapsed.delete(nodeId);
            } else {
                collapsed.add(nodeId);
            }
            // Hide the tooltip immediately — show_item_details() destroys
            // the sigma instance whose outNode would otherwise hide it.
            hide_node_tooltip();
            // show_item_details rebuilds materials + tree + graph against
            // the new collapsed set. (render_graph alone wouldn't refresh
            // the materials totals.)
            show_item_details();
        });

        // Hover tooltip — sigma fires overNode/outNode against the canvas
        // hit-test. captor.clientX/Y are in viewport coords (matches our
        // fixed-positioned tooltip).
        graph.bind('overNode', function(e) {
            show_node_tooltip(
                e.data.node.id,
                e.data.captor.clientX,
                e.data.captor.clientY,
            );
        });
        graph.bind('outNode', hide_node_tooltip);

        graph.startForceAtlas2();
        // Settle strategy: sample node positions every ATLAS_SAMPLE_MS;
        // compare the mean position of the most-recent WINDOW samples to
        // the mean of the prior WINDOW. If the means barely shift (drift
        // < ATLAS_SETTLE_THRESHOLD of the current bbox diagonal), the
        // layout has stopped CONVERGING — kill atlas. Comparing windowed
        // means (not raw deltas) catches both:
        //   - actually settled: per-sample movement is ~0, so are means
        //   - oscillating-around-a-center: per-sample movement is big
        //     but the means cancel out to the oscillation center. Common
        //     on 3-4-node graphs where forceAtlas2's repulsion never
        //     fully balances the gravity term and one node bounces.
        // Hard cap at ATLAS_MAX_RUN regardless, and an early kill on
        // first mouse move into the graph after a grace period (hover /
        // click hit-tests fight moving nodes, so killing on interaction
        // gives a snappy feel). Reload button (⟳) re-runs atlas.
        var atlas_start = Date.now();
        var ATLAS_MIN_RUN = 500;
        var ATLAS_MAX_RUN = 5000;
        var ATLAS_SAMPLE_MS = 120;
        var ATLAS_WINDOW = 4;             // samples per window
        var ATLAS_SETTLE_THRESHOLD = 0.01; // 1% of bbox diagonal
        var pos_history = [];             // ring of position snapshots

        function snapshot_positions() {
            try {
                return graph.graph.nodes().map(function(n) {
                    return { x: n.x, y: n.y };
                });
            } catch (e) {
                return null;  // sigma may have been killed
            }
        }
        function bbox_diag(pos) {
            var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
            for (var i = 0; i < pos.length; i++) {
                var p = pos[i];
                if (p.x < minx) minx = p.x;
                if (p.x > maxx) maxx = p.x;
                if (p.y < miny) miny = p.y;
                if (p.y > maxy) maxy = p.y;
            }
            var w = maxx - minx, h = maxy - miny;
            return Math.sqrt(w*w + h*h) || 1;
        }
        function kill_atlas() {
            try { graph.killForceAtlas2(); } catch (e) {}
            clearTimeout(graph_force_timeout);
            clearInterval(graph_force_interval);
            graph_display.off('mousemove.atlas');
        }
        graph_force_timeout = window.setTimeout(kill_atlas, ATLAS_MAX_RUN);
        graph_force_interval = window.setInterval(function() {
            var pos = snapshot_positions();
            if (!pos) return;
            pos_history.push(pos);
            if (pos_history.length > ATLAS_WINDOW * 2) pos_history.shift();

            if (Date.now() - atlas_start < ATLAS_MIN_RUN) return;
            if (pos_history.length < ATLAS_WINDOW * 2) return;
            // Per-node mean over older half and newer half of the buffer.
            var n = pos.length;
            var total_drift = 0;
            for (var i = 0; i < n; i++) {
                var ox = 0, oy = 0, rx = 0, ry = 0;
                for (var s = 0; s < ATLAS_WINDOW; s++) {
                    ox += pos_history[s][i].x;
                    oy += pos_history[s][i].y;
                    rx += pos_history[ATLAS_WINDOW + s][i].x;
                    ry += pos_history[ATLAS_WINDOW + s][i].y;
                }
                var dx = (rx - ox) / ATLAS_WINDOW;
                var dy = (ry - oy) / ATLAS_WINDOW;
                total_drift += Math.sqrt(dx * dx + dy * dy);
            }
            var avg_drift = total_drift / n;
            if (avg_drift / bbox_diag(pos) < ATLAS_SETTLE_THRESHOLD) {
                kill_atlas();
            }
        }, ATLAS_SAMPLE_MS);

        // Per-render namespaced handler; cleared by the next render_graph
        // call's graph.kill() + the .off() at the top of this function.
        graph_display.off('mousemove.atlas');
        graph_display.on('mousemove.atlas', function() {
            if (Date.now() - atlas_start < ATLAS_MIN_RUN) return;
            kill_atlas();
        });
    }

    function calculate_total_materials(item) {
        var total_materials = { raw: {}, built: {} };
        total_materials.built[item.name] = 1;

        // visited tracks the ancestry chain to break transitive cycles —
        // possible now that alternative recipes can chain back through
        // their producers (e.g. picking an "X via Y, where Y is made from
        // X" alternative). A direct same-recipe recycle is filtered at
        // build time; this is the defensive net for combinations.
        function count_material_list(mats, multiplier, visited) {
            for (var mat_key in mats) {
                if (visited.has(mat_key)) continue;
                var total_needed = mats[mat_key] * multiplier;
                if (has_active_recipe(mat_key)) {
                    var rec = active_recipe(mat_key);
                    total_materials.built[mat_key] = (total_materials.built[mat_key] || 0) + total_needed;
                    var sub = new Set(visited);
                    sub.add(mat_key);
                    count_material_list(rec.mats, total_needed, sub);
                } else {
                    total_materials.raw[mat_key] = (total_materials.raw[mat_key] || 0) + total_needed;
                }
            }
        }

        // Selected item is the root of `visited` — that's the seed, and
        // any recipe path that would loop back to it stops there. Use the
        // ACTIVE recipe's mats so a root-level override (e.g. picking
        // reforming-refine for refined oil) traverses the chosen
        // ingredients, not the inline default mats.
        var root_rec = active_recipe(item.name) || item;
        count_material_list(root_rec.mats || {}, 1, new Set([item.name]));

        return total_materials;
    }

    // ---------- in-game-style item picker ------------------------------

    function picker_available() {
        // True iff this game's data has full layout info on at least one
        // entry (category + row + col + icon). Cheap O(N) scan; only called
        // on game change / picker open.
        for (var k in items) {
            var e = items[k];
            if (e.category && e.row !== undefined &&
                e.col !== undefined && e.icon) return true;
        }
        return false;
    }

    function picker_categories() {
        // Distinct categories present in items, in the order we first see
        // them. factoriolab orders 'components' before 'buildings' in its
        // upstream array, so iterating items by insertion gives us the
        // same tab order as the in-game Replicator.
        var seen = {}, out = [];
        for (var k in items) {
            var c = items[k].category;
            if (c && !seen[c]) { seen[c] = true; out.push(c); }
        }
        return out;
    }

    function scale_position(pos, factor) {
        // 'X[px] Y[px]' -> each value multiplied by `factor`. Used to scale
        // sprite background-position when we shrink tiles below native cell
        // size (the sheet is rendered at `factor * 1472px` to keep cells
        // square, and positions stored in dyson.json are 64-px-cell coords).
        // Robust to a missing 'px' or stray whitespace.
        return pos.split(/\s+/).map(function(s) {
            var n = parseInt(s, 10);
            return (isNaN(n) ? 0 : (n * factor)) + 'px';
        }).join(' ');
    }

    // Rows wider than this are split into chunks of ceil(N/chunks) before
    // rendering — Factorio SA's fluids row (22 items) and combat row
    // (17) are an unworkable single line otherwise. Picked so a 12-item
    // row (intermediate-products/3) stays on one line.
    var PICKER_MAX_ROW = 12;

    function split_row(arr) {
        // Split into roughly-equal chunks no larger than PICKER_MAX_ROW.
        // 22 -> 2 chunks of 11; 17 -> 9+8; 13 -> 7+6.
        if (arr.length <= PICKER_MAX_ROW) return [arr];
        var chunks = Math.ceil(arr.length / PICKER_MAX_ROW);
        var size = Math.ceil(arr.length / chunks);
        var out = [];
        for (var i = 0; i < arr.length; i += size) {
            out.push(arr.slice(i, i + size));
        }
        return out;
    }

    function compute_picker_icon_size() {
        // Fit the widest VISUAL row (after wrapping long rows via
        // split_row) into the panel's grid area. Constants here mirror
        // the CSS: side panel 240, grid padding 14 each side, panel
        // border 1 each side, separator 1, item gap 4. Math:
        // usable_grid_w = panel_w - side - grid_padding*2 - borders;
        // tile_w = (usable_grid_w - gap*(WIDEST-1)) / WIDEST. Clamp 36-64.
        var widest = 1;
        var rowCounts = {};
        for (var k in items) {
            var e = items[k];
            if (e.category === undefined || e.row === undefined) continue;
            var key = e.category + '/' + e.row;
            rowCounts[key] = (rowCounts[key] || 0) + 1;
        }
        for (var rk in rowCounts) {
            // The widest visual chunk for an N-item row matches the
            // chunkSize math split_row uses.
            var n = rowCounts[rk];
            var chunks = Math.max(1, Math.ceil(n / PICKER_MAX_ROW));
            var chunkSize = Math.ceil(n / chunks);
            if (chunkSize > widest) widest = chunkSize;
        }
        var PANEL_OVERHEAD = 240 + 14 * 2 + 2 + 1;  // = 271
        var GAP = 4;
        var panel_max = Math.min(window.innerWidth * 0.95, 1280);
        var grid_inner = panel_max - PANEL_OVERHEAD;
        var size = Math.floor((grid_inner - GAP * (widest - 1)) / widest);
        return Math.max(36, Math.min(64, size));
    }

    function render_picker_tabs(cats) {
        picker_tabs_el.empty();
        cats.forEach(function(cat) {
            var btn = $('<button class="picker-tab" type="button"></button>')
                .text(cat)
                .toggleClass('active', cat === picker_active_tab)
                .on('click', function() {
                    picker_active_tab = cat;
                    picker_tabs_el.find('.picker-tab').removeClass('active');
                    $(this).addClass('active');
                    render_picker_grid();
                });
            picker_tabs_el.append(btn);
        });
    }

    function render_picker_grid() {
        // Group active-tab items by their `row`, then sort each row by `col`
        // — both come straight from the upstream data so the visual layout
        // matches the in-game Replicator panel position-for-position.
        // Rows wider than PICKER_MAX_ROW are wrapped via split_row into
        // multiple visual rows (Factorio SA's fluids tab is one upstream
        // row of 22; rendered as a single line it's an unreadable mess).
        var rows = {};
        for (var k in items) {
            var e = items[k];
            if (e.category !== picker_active_tab) continue;
            (rows[e.row] = rows[e.row] || []).push({ key: k, entry: e });
        }
        picker_grid_el.empty();
        var factor = picker_icon_size / 64;
        Object.keys(rows).map(Number).sort(function(a, b) { return a - b; })
            .forEach(function(rnum) {
                var row = rows[rnum].sort(function(a, b) {
                    return a.entry.col - b.entry.col;
                });
                split_row(row).forEach(function(chunk) {
                    var rowEl = $('<div class="picker-row"></div>');
                    chunk.forEach(function(it) {
                        // Tile box size is set by --icon-size (CSS); the
                        // sprite scales with it; the per-tile position is
                        // the 64-px-cell value scaled to match.
                        var tile = $('<div class="picker-item"></div>')
                            .attr('data-item', it.key)
                            .attr('title', it.key)
                            .css('background-position', scale_position(it.entry.icon, factor))
                            .on('mouseenter', function() { render_picker_side(it.key); })
                            .on('click', function() { pick_item(it.key); });
                        rowEl.append(tile);
                    });
                    picker_grid_el.append(rowEl);
                });
            });
    }

    function render_picker_side(key) {
        // Hover preview: large icon, name, time/output, ingredient list with
        // half-scale sprite cells. Same data the calculator's main view uses
        // — this is just a quick look before committing to a selection.
        var e = items[key];
        if (!e) return;
        var html = '<div class="picker-side-icon" style="background-position: '
            + e.icon + '"></div>';
        html += '<div class="picker-side-name">' + key + '</div>';
        if (e.recipe && e.time !== undefined && !isNaN(e.time)) {
            var out = e.produced || 1;
            // time/produced already happens in divide_item_time_and_mats_...
            // so e.time is per-unit; show the per-craft view here (multiply
            // back) which matches what users see in-game.
            var per_craft_time = (e.time * out).toFixed(out === 1 ? 0 : 1);
            html += '<div class="picker-side-meta">produces ' + out
                + ' / ' + per_craft_time + 's</div>';
        } else {
            html += '<div class="picker-side-meta">raw resource</div>';
        }
        if (e.mats && Object.keys(e.mats).length > 0) {
            html += '<h4>Ingredients</h4>';
            for (var matKey in e.mats) {
                var mat = items[matKey];
                var pos = (mat && mat.icon) ? mat.icon : '0px 0px';
                // mats were normalized to per-1-output by the divide-step;
                // show per-craft counts (multiply back) so the side panel
                // reads like the in-game recipe (e.g. "2 magnet" not "1").
                var count = e.mats[matKey] * (e.produced || 1);
                html += '<div class="picker-side-mat">'
                    + '<div class="picker-side-mat-icon" style="'
                    + 'background-position: ' + scale_position(pos, 0.5)
                    + '"></div>'
                    + '<div class="picker-side-mat-name">' + matKey + '</div>'
                    + '<div class="picker-side-mat-count">' + count + '</div>'
                    + '</div>';
            }
        }
        picker_side_el.html(html);
    }

    function pick_item(key) {
        // The dropdown is the source of truth for the rest of the app —
        // setting its value and firing change() reuses ALL existing logic
        // (URL sync, localStorage, tree render, graph render, hide buttons).
        item_select.val(key);
        item_select.change();
        close_picker();
    }

    function apply_picker_icon_size() {
        // Recompute and apply --icon-size, then re-render the grid so each
        // tile's inline background-position uses the new scale factor.
        // Called on open and whenever the window resizes while open.
        picker_icon_size = compute_picker_icon_size();
        picker_panel_el.css('--icon-size', picker_icon_size + 'px');
        // The grid tile's background-size needs to scale the sprite to
        // (icon_size / 64) of natural — but we can't express that purely
        // in CSS calc(): --icon-size is already a length, multiplying it
        // by var(--sprite-natural-w) * 1px yields length*length which the
        // calc grammar rejects (silently falls back to `auto`, leaving
        // the sprite at full natural size — the symptom is tiles showing
        // tiny mis-aligned fragments of the sheet). Compute the final
        // length here and hand it to CSS as a single var. The
        // fixed-element selectors (tooltip, badge, side panel) DO live
        // entirely in number-land until a single * 1px at the end, so
        // their calcs stay in CSS.
        var natural_w = (GAMES[current_game] && GAMES[current_game].sprite_natural_w) || 1472;
        picker_panel_el.css('--picker-sprite-size',
            (picker_icon_size / 64 * natural_w) + 'px');
        if (picker_grid_el.children().length > 0) render_picker_grid();
    }

    function open_picker() {
        if (!picker_available()) return;
        var cats = picker_categories();
        if (cats.length === 0) return;
        if (!picker_active_tab || cats.indexOf(picker_active_tab) === -1) {
            // Prefer the "things you produce intermediate of" tab — DSP
            // calls it 'components', Factorio calls it
            // 'intermediate-products'. Fall back to whichever category
            // shows up first. Whichever tab the user picks afterward is
            // remembered for the session (picker_active_tab persists
            // across close/open), but resets when the active game changes.
            var preferred = ['components', 'intermediate-products'];
            picker_active_tab = preferred.find(function(c) {
                return cats.indexOf(c) !== -1;
            }) || cats[0];
        }
        apply_picker_icon_size();
        render_picker_tabs(cats);
        render_picker_grid();
        // If an item is currently selected and it's in this game's data,
        // pre-fill the side panel with it; otherwise show the hover hint.
        var sel = item_select.val();
        if (sel && items[sel] && items[sel].icon) {
            render_picker_side(sel);
        } else {
            picker_side_el.html('<p class="picker-hint">Hover an item</p>');
        }
        picker_overlay.removeAttr('hidden');
    }

    function close_picker() {
        picker_overlay.attr('hidden', '');
    }

    function update_picker_button() {
        // Picker-enabled games show the current-selection badge (the only
        // entry into the modal picker now) and HIDE the native <select>.
        // Dropdown-only games (factorio) keep the <select> and hide the
        // badge. item_select stays the source of truth for the selection
        // in both modes.
        if (picker_available()) {
            current_selection_btn.removeAttr('hidden');
            item_select.attr('hidden', '');
            update_current_selection();
        } else {
            current_selection_btn.attr('hidden', '');
            item_select.removeAttr('hidden');
        }
    }

    function update_current_selection() {
        // Refresh the badge's icon + name from item_select.val(). Called
        // on item change, on game change (after update_picker_button), and
        // any time the selection might have shifted. visibility:hidden on
        // the icon (not display:none) keeps the badge width stable when
        // nothing is selected.
        var sel = item_select.val();
        var entry = items[sel];
        var iconEl = current_selection_btn.find('.cs-icon');
        var nameEl = current_selection_btn.find('.cs-name');
        if (sel && entry && entry.icon) {
            iconEl.css({
                'background-position': scale_position(entry.icon, 24/64),
                'visibility': 'visible',
            });
            nameEl.text(sel).removeClass('empty');
        } else {
            iconEl.css('visibility', 'hidden');
            nameEl.text('pick an item').addClass('empty');
        }
    }

    // ---------- end picker ----------------------------------------------

    // ---------- recipe-override persistence -----------------------------
    // Production choices are mostly a function of game progression — the
    // user unlocks advanced-oil-processing and from then on always wants
    // that picked, etc. Persist their picks per-game so the next visit
    // restores them rather than dropping back to inline defaults.
    //
    // Stored as a {itemName: recipeId} object under one key per game.
    // collapsed nodes are intentionally NOT persisted — those are more
    // "I'm focused on this corner of the tree right now" than a durable
    // preference.

    function recipe_overrides_storage_key() {
        return 'recipe_overrides:' + current_game;
    }

    function save_recipe_overrides() {
        var obj = {};
        recipe_overrides.forEach(function(v, k) { obj[k] = v; });
        try {
            localStorage.setItem(
                recipe_overrides_storage_key(),
                JSON.stringify(obj),
            );
        } catch (e) { /* quota / disabled — silently skip */ }
    }

    function load_recipe_overrides() {
        // Validate each entry against the current items data: drop
        // overrides whose item no longer exists OR whose recipe id is no
        // longer one of the item's alternatives (factoriolab upstream
        // can rename / remove recipes between snapshots; we don't want a
        // stale override to silently shadow a valid default).
        var m = new Map();
        var raw;
        try {
            raw = localStorage.getItem(recipe_overrides_storage_key());
        } catch (e) { return m; }
        if (!raw) return m;
        var obj;
        try { obj = JSON.parse(raw); } catch (e) { return m; }
        for (var name in obj) {
            var recipeId = obj[name];
            var entry = items[name];
            if (!entry || !entry.alternatives) continue;
            for (var i = 0; i < entry.alternatives.length; i++) {
                if (entry.alternatives[i].recipe === recipeId) {
                    m.set(name, recipeId);
                    break;
                }
            }
        }
        return m;
    }
    // --------------------------------------------------------------------

    function load_game(game_id) {
        current_game = GAMES[game_id] ? game_id : DEFAULT_GAME;
        game_select.val(current_game);
        localStorage.setItem('last_game', current_game);

        // Apply this game's sprite sheet via CSS custom properties on
        // body — the picker tiles, tooltip icons, current-selection badge,
        // and ingredient-list icons all consume var(--sprite-url) and
        // var(--sprite-natural-w). Setting before the data fetch resolves
        // means there's no flash of the wrong sprite when switching games.
        var g = GAMES[current_game];
        if (g.sprite) {
            document.body.style.setProperty('--sprite-url',
                "url('" + g.sprite + "')");
        }
        if (g.sprite_natural_w) {
            document.body.style.setProperty('--sprite-natural-w',
                g.sprite_natural_w);
        }

        return fetch(GAMES[current_game].file)
            .then(function(response) {
                if (!response.ok) {
                    throw new Error('HTTP ' + response.status);
                }
                return response.json();
            })
            .then(function(data) {
                items = data;
                divide_item_time_and_mats_and_add_name();
                collapsed = new Set();  // collapsed names don't survive a game switch
                // recipe_overrides DO survive — they're per-game progression
                // preferences (kovarex unlocked, foundry path preferred,
                // etc.). load_recipe_overrides validates stored entries
                // against the freshly loaded items so stale picks don't
                // shadow a valid default.
                recipe_overrides = load_recipe_overrides();
                populate_select();
                update_picker_button();
                close_picker();  // close stale picker if game changed mid-open
                recipe_picker_panel.empty();
                // Preserve the static .graph-legend (it survives game
                // switches too — the four-color legend is universal).
                graph_display.children().not('.graph-legend').remove();
                // Buildings file (optional per game). Fetch separately so a
                // missing file just disables the buildings tooltip section
                // — doesn't break the rest of the game load.
                buildings = null;
                if (GAMES[current_game].buildings) {
                    return fetch(GAMES[current_game].buildings)
                        .then(function(r) { return r.ok ? r.json() : null; })
                        .then(function(b) { buildings = b; })
                        .catch(function() { /* leave buildings = null */ });
                }
            })
            .catch(function(err) {
                items = {};
                populate_select();
                recipe_picker_panel.empty().append(
                    `<h2>Could not load ${current_game} data</h2>`,
                    `<p class="rp-hint">${err.message}. If you opened this file directly, serve it ` +
                    `(e.g. <code>python3 -m http.server</code>) &mdash; fetch() is blocked on file://.</p>`
                );
            });
    }

    function init() {
        populate_game_select();

        // Guards the initial restore: when we programmatically re-select the
        // saved item on load, the item_select handler must NOT wipe the count
        // we just restored. A real user item switch leaves this false.
        var restoring_count = false;

        item_select.change(function() {
            localStorage.setItem('last_item', this.value);
            // Switching items clears the count back to the default (blank
            // field → "Default: 1" placeholder). The cleared value is also
            // persisted so a reload mid-selection stays at the default.
            // Skipped during the initial restore so a reload keeps the saved
            // count (restoring_count is set only around that one trigger).
            if (!restoring_count) {
                per_sec_input.val('');
                localStorage.removeItem('last_per_sec');
            }
            update_url();
            update_current_selection();
            show_item_details();
        });
        per_sec_input.change(function() {
            // Persist the on-screen count so a page reload reopens to the
            // same value (companion to last_game / last_item). Store the
            // raw field text — empty stays empty so the placeholder shows.
            localStorage.setItem('last_per_sec', per_sec_input.val());
            show_item_details();
        });
        per_sec_input.keypress(function(e) {
            e.stopPropagation();
        });

        game_select.change(function() {
            load_game(this.value).then(function() {
                // Try to use the new game's default item; fall back to
                // empty if no default is configured / present. Either
                // way, fire .change() so the rest of the UI catches up.
                var def = default_item_for_game(current_game);
                item_select.val(def);
                if (def) {
                    item_select.change();
                } else {
                    update_url();
                    update_current_selection();
                }
            });
        });

        // Picker wiring: open via the current-selection badge (only entry
        // point now); close via × / backdrop / Esc. Backdrop click only
        // fires when the user clicks the OVERLAY itself (not bubbled
        // from the panel), which is the conventional dismiss.
        current_selection_btn.on('click', open_picker);
        $("#picker_close").on('click', close_picker);
        picker_overlay.on('click', function(e) {
            if (e.target === this) close_picker();
        });
        $(document).on('keydown', function(e) {
            if (e.key === 'Escape' && !picker_overlay.attr('hidden')) {
                close_picker();
            }
        });

        // Re-fit icon size when the viewport changes while the picker is
        // open (window resize, orientation flip, devtools panel toggle).
        $(window).on('resize', function() {
            if (!picker_overlay.attr('hidden')) apply_picker_icon_size();
        });

        $("body").keypress(function(e) {
            var per_sec = parseFloat(per_sec_input.val()) || 1.0;

            switch (e.keyCode) {
                case 97:
                    per_sec -= 0.01;
                    break;
                case 115:
                    per_sec += 0.01;
                    break;
            }
            per_sec_input.val(per_sec.toFixed(2));
            per_sec_input.change();
        });

        var params = get_url_params();
        var start_game = params['game'] || localStorage.getItem('last_game') || DEFAULT_GAME;

        // Restore the saved count before the first show_item_details() (fired
        // by item_select.change below) reads per_sec_input.val(). Empty/absent
        // leaves the field blank so the "Default: 1" placeholder shows.
        var saved_per_sec = localStorage.getItem('last_per_sec');
        if (saved_per_sec) per_sec_input.val(saved_per_sec);

        load_game(start_game).then(function() {
            // Selection precedence: URL ?item= > localStorage > game default.
            // Each candidate is only used if it actually exists in the
            // current items map (e.g. a URL from a different game won't
            // false-match here). The game default lets a brand-new visitor
            // land on a populated tree instead of an empty page.
            var selected_item = params['item'] || localStorage.getItem('last_item');
            if (!(selected_item && items[selected_item])) {
                selected_item = default_item_for_game(start_game);
            }
            if (selected_item) {
                item_select.val(selected_item);
                restoring_count = true;   // keep the restored count, don't reset
                item_select.change();
                restoring_count = false;
            } else {
                update_url();
                update_current_selection();
            }
        });
    }

    function default_item_for_game(g) {
        var d = GAMES[g] && GAMES[g].default_item;
        return (d && items[d]) ? d : '';
    }

    // ---------- graph node tooltip --------------------------------------

    function show_node_tooltip(nodeId, x, y, explicit_recipe) {
        // Quantity-needed (built or raw) for the hovered node, plus a
        // recipe's production-units / buildings / byproducts. By default
        // the recipe shown is whatever active_recipe() resolves to —
        // default or the user's override pick. The recipe picker passes
        // an `explicit_recipe` so hovering a specific option there
        // previews THAT recipe's numbers (what would happen if you
        // picked it) instead of the currently-active one.
        var per_sec = parseFloat(per_sec_input.val()) || 1;
        var is_collapsed = collapsed.has(nodeId);
        var rec = explicit_recipe || active_recipe(nodeId);
        var item_entry = items[nodeId];
        var has_recipe = rec && rec.mats
            && Object.keys(rec.mats).length > 0;

        // Pull count from the latest computed totals (built OR raw side).
        var count = 0;
        if (total_materials) {
            if (total_materials.built[nodeId] !== undefined) count = total_materials.built[nodeId];
            else if (total_materials.raw[nodeId] !== undefined) count = total_materials.raw[nodeId];
        }

        // Header icon: 32px sprite cell at half-scale (background-size
        // 736px). scale_position halves the original 64-px-cell position.
        // Skipped silently for games without icons (factorio.json).
        var iconSpan = '';
        if (item_entry && item_entry.icon) {
            iconSpan = '<span class="node-tooltip-icon" style="'
                + 'background-position: ' + scale_position(item_entry.icon, 0.5)
                + '"></span>';
        }
        // Yield suffix: when a recipe makes >1 of its primary output per
        // craft (e.g. Factorio gravity-matrix-equivalent recipes that
        // yield 2 per craft) the per-unit ingredient counts can look
        // wrong at a glance — "1/s output, 0.5/s of each ingredient"
        // reads like a bug unless you know the recipe produces 2 at a
        // time. The suffix surfaces that so the math is self-explanatory.
        // Fractional yields (<1) like uranium-processing's 0.993 U-238
        // would just render as confusing decimals; skip those.
        var yield_suffix = '';
        if (rec && rec.produced > 1) {
            yield_suffix = '<span class="node-tooltip-yield">×'
                + format_num(rec.produced) + '</span>';
        }
        var html = '<div class="node-tooltip-name">'
            + iconSpan + '<span>' + nodeId + '</span>'
            + yield_suffix + '</div>';
        html += '<div class="node-tooltip-row">'
            + '<span class="key">needed</span>'
            + '<span class="val accent">' + format_num(count * per_sec) + '/s</span></div>';

        if (has_recipe && !is_collapsed && rec.time) {
            // Production units = "recipe-seconds per real second of output".
            // One building at speed S produces S production-units per real
            // second, so buildings_needed = production_units / S.
            var production_units = count * rec.time * per_sec;
            html += '<div class="node-tooltip-row">'
                + '<span class="key">production units</span>'
                + '<span class="val">' + format_num(production_units) + '</span></div>';
            // Per-tier building counts. We don't ceiling — the user can
            // round mentally; the fractional value tells them how loaded
            // the last building will run.
            var producers_list = rec.producers || [];
            var tiers = [];
            if (buildings) {
                for (var i = 0; i < producers_list.length; i++) {
                    var b = buildings[producers_list[i]];
                    if (b && b.speed) tiers.push({ id: producers_list[i], b: b });
                }
            }
            // Ingredients — incoming flow rates. The graph arrows already
            // show ingredient relationships but not magnitudes; the
            // tooltip is where the actual per-second numbers belong. Each
            // row matches the byproducts/buildings layout (inline icon +
            // name on the left, rate on the right). Listed before
            // buildings because "what goes in" is usually what the user
            // is reading the tooltip for; buildings are how-to-realize.
            html += '<div class="node-tooltip-section">ingredients</div>';
            for (var mat in rec.mats) {
                var mat_rate = rec.mats[mat] * count * per_sec;
                var mat_entry = items[mat];
                var matIcon = (mat_entry && mat_entry.icon)
                    ? '<span class="node-tooltip-inline-icon" style="'
                    + 'background-position: ' + scale_position(mat_entry.icon, 20/64)
                    + '"></span>' : '';
                html += '<div class="node-tooltip-row">'
                    + '<span class="key">' + matIcon + mat + '</span>'
                    + '<span class="val">' + format_num(mat_rate) + '/s</span></div>';
            }
            // Byproducts — pure info ("you'll also get N of X for free").
            // No math credit; the calculator double-counts. User decides
            // what to do with the extra. Placed BEFORE buildings so the
            // buildings section is always the last block in the tooltip
            // — its presence/absence doesn't shift other content around,
            // and buildings (the most-frequently-read section) lives in
            // a predictable spot at the bottom.
            if (rec.byproducts && Object.keys(rec.byproducts).length > 0) {
                html += '<div class="node-tooltip-section">also produces</div>';
                for (var bp in rec.byproducts) {
                    var bp_rate = rec.byproducts[bp] * count * per_sec;
                    var bp_entry = items[bp];
                    var bpIcon = (bp_entry && bp_entry.icon)
                        ? '<span class="node-tooltip-inline-icon" style="'
                        + 'background-position: ' + scale_position(bp_entry.icon, 20/64)
                        + '"></span>' : '';
                    html += '<div class="node-tooltip-row">'
                        + '<span class="key">' + bpIcon + bp + '</span>'
                        + '<span class="val">' + format_num(bp_rate) + '/s</span></div>';
                }
            }
            if (tiers.length > 0) {
                html += '<div class="node-tooltip-section">buildings</div>';
                for (var j = 0; j < tiers.length; j++) {
                    var t = tiers[j];
                    var n = production_units / t.b.speed;
                    // Inline 20px icon — building icons come from
                    // dyson-buildings.json (added there during build).
                    var bldgIcon = t.b.icon ? '<span class="node-tooltip-inline-icon" style="'
                        + 'background-position: ' + scale_position(t.b.icon, 20/64)
                        + '"></span>' : '';
                    html += '<div class="node-tooltip-row">'
                        + '<span class="key">' + bldgIcon
                        + t.b.name + ' (' + t.b.speed + 'x)</span>'
                        + '<span class="val">' + format_num(n) + '</span></div>';
                }
            }
        } else if (is_collapsed) {
            html += '<div class="node-tooltip-tag collapsed">collapsed</div>';
        } else if (!has_recipe) {
            html += '<div class="node-tooltip-tag raw">raw resource</div>';
        }

        node_tooltip.html(html);
        // Show off-screen first so we can measure, then reposition. Offset
        // by ~14px so the cursor doesn't sit on the tooltip; flip to the
        // other side near viewport edges so it stays fully visible.
        node_tooltip.css({ left: -9999, top: -9999 }).removeAttr('hidden');
        var ttW = node_tooltip.outerWidth();
        var ttH = node_tooltip.outerHeight();
        var left = x + 14;
        var top  = y + 14;
        if (left + ttW > window.innerWidth - 6)  left = x - ttW - 14;
        if (top  + ttH > window.innerHeight - 6) top  = y - ttH - 14;
        node_tooltip.css({ left: Math.max(6, left), top: Math.max(6, top) });
    }

    function hide_node_tooltip() {
        node_tooltip.attr('hidden', '');
    }

    // Graph palette — four distinct hues, all readable on the navy panel:
    //   red:    the selected root (the thing being computed)
    //   yellow: user-collapsed nodes ("treat as raw") — visually distinct
    //           from naturally raw so it's obvious which were YOUR choice
    //   green:  naturally raw resources (no recipe / empty mats)
    //   slate:  intermediates (everything else; recedes between the two
    //           emphasis colors above)
    var GRAPH_COLOR_SELECTED  = '#4a9eff';   // sky blue — root
    var GRAPH_COLOR_COLLAPSED = '#ffe066';   // yellow — user-collapsed
    var GRAPH_COLOR_RAW       = '#5cf089';   // green — naturally raw
    var GRAPH_COLOR_DEFAULT   = '#7a99b8';   // slate — intermediates
    var GRAPH_COLOR_EDGE      = '#6b8aa8';   // mid blue — edges

    function makeGraph(item) {
        // Sigma sizes its canvas from the container's getBoundingClientRect,
        // which includes padding — so if we hand it #graph directly, the
        // canvas overdraws the h2's padded area. Putting the canvas in its
        // own child div keeps the h2 above + lets us pad #graph normally.
        // render_graph calls graph_display.empty() before this, so the
        // wrapper is fresh every render.
        var canvasContainer = $('<div class="graph-canvas"></div>')
            .appendTo(graph_display)[0];
        return new sigma({
            renderer: {
                container: canvasContainer,
                type: 'canvas'
            },
            settings: {
                minArrowSize: 7,
                sideMargin: 1,
                mouseWheelEnabled: true,
                // mouseEnabled: true lets us bind clickNode for the
                // "collapse on click" interaction. It also enables sigma's
                // default click-drag camera pan; for our small graphs
                // that's a minor side effect at worst, and clicks still
                // register cleanly as long as the cursor doesn't move
                // between mousedown and mouseup.
                mouseEnabled: true,
                doubleClickEnabled: false,  // don't zoom on dbl-click
                // Sigma scales nodes by their `size` attribute against
                // these bounds. Our nodes ship size:3 (see makeNodes); a
                // minNodeSize of 4 keeps them visible without crowding
                // the canvas; maxNodeSize keeps hub nodes proportional.
                minNodeSize: 4,
                maxNodeSize: 11,
                // Sigma hides labels for nodes smaller than labelThreshold
                // (default 6). We want labels on every node — this IS the
                // navigation aid of the graph — so force them on.
                labelThreshold: 1,
                defaultLabelSize: 13,
                defaultLabelColor: '#d4e6ff',
                font: 'system-ui, -apple-system, sans-serif',
                defaultEdgeColor: GRAPH_COLOR_EDGE,
                edgeColor: 'default',
            },
            graph: {
                nodes: makeNodes(item.name, {}, true),
                edges: makeEdges(item.name, {}),
            },
        });
    }

    function makeNodes(item_name, nodes, first_node = false) {
        if (nodes[item_name] === undefined) {
            // Color priority: root > collapsed > naturally-raw > default.
            // has_active_recipe respects the user's recipe-override choice
            // (alternative may have different mats than default).
            var is_collapsed = collapsed.has(item_name);
            var color = GRAPH_COLOR_DEFAULT;
            if (first_node) {
                color = GRAPH_COLOR_SELECTED;
            } else if (is_collapsed) {
                color = GRAPH_COLOR_COLLAPSED;
            } else if (!has_active_recipe(item_name)) {
                color = GRAPH_COLOR_RAW;
            }
            nodes[item_name] = {
                id: item_name,
                label: item_name,
                x: Math.random(),
                y: Math.random(),
                // Sigma scales this against minNodeSize/maxNodeSize; 3 is
                // the unit "leaf" size, the selected/hub nodes naturally
                // appear larger because they sit at the center of more
                // edges (forceAtlas2 layout).
                size: 3,
                color,
            };
            // Recurse via the ACTIVE recipe's mats (override-aware).
            // Anything reached only via a collapsed or override-cut branch
            // simply never enters the node set — orphans disappear.
            if (has_active_recipe(item_name)) {
                var rec = active_recipe(item_name);
                for (var mat_key in rec.mats) {
                    makeNodes(mat_key, nodes);
                }
            }
        }
        return Object.values(nodes);
    }

    function makeEdges(item_name, edges) {
        // Use the active recipe's mats so swapping to an alternative
        // re-routes edges to the right ingredients.
        if (has_active_recipe(item_name)) {
            var rec = active_recipe(item_name);
            for (var mat_key in rec.mats) {
                edge_name = mat_key + "->" + item_name;
                if (edges[edge_name] === undefined) {
                    edges[edge_name] = {
                        id: edge_name,
                        source: mat_key,
                        target: item_name,
                        type: "arrow",
                        // size:1 on a dark background was nearly invisible;
                        // 2.5 reads cleanly without crowding the canvas.
                        size: 2.5,
                        color: GRAPH_COLOR_EDGE,
                    }
                    makeEdges(mat_key, edges);
                }
            }
        }
        return Object.values(edges);
    }

    function divide_item_time_and_mats_and_add_name() {
        // Normalize each recipe's time/mats/byproducts to per-1-output units
        // — the calculator's math is in "per item produced" everywhere, and
        // the JSON stores raw recipe quantities (e.g. plasma-refining
        // makes 1 H + 2 refined-oil from 2 crude oil; we want time and
        // mats expressed per 1 H of output). Also normalizes every entry
        // in `alternatives`, which has its own produced value per alt.
        function normalize(rec) {
            if (rec.produced === undefined) rec.produced = 1;
            if (rec.time !== undefined) rec.time /= rec.produced;
            for (var k in rec.mats) rec.mats[k] /= rec.produced;
            for (var k in rec.byproducts) rec.byproducts[k] /= rec.produced;
        }
        for (var main_item_key in items) {
            var main_item = items[main_item_key];
            main_item.name = main_item_key;
            // Only normalize entries that have a recipe (raw leaves have
            // no time/mats — they're pickable but un-craftable).
            if (main_item.time !== undefined) normalize(main_item);
            for (var alt of (main_item.alternatives || [])) normalize(alt);
        }
    }

    // Resolve which recipe-data to use for an item: the user's override (if
    // any and still present in alternatives), else the inline default. The
    // returned object has the same recipe-level fields whether default or
    // alternative — time, produced, mats, producers, byproducts — so call
    // sites don't branch on which. Item-level fields (category/row/col/icon)
    // always live on items[name] itself, not on alternatives.
    function active_recipe(item_name) {
        var entry = items[item_name];
        if (!entry) return null;
        var override = recipe_overrides.get(item_name);
        if (override && entry.alternatives) {
            for (var alt of entry.alternatives) {
                if (alt.recipe === override) return alt;
            }
        }
        return entry;  // default — inline fields on the entry itself
    }

    // True iff the item has at least one recipe path AND isn't user-collapsed.
    // Tree walkers / tooltip use this to decide whether to recurse or stop.
    function has_active_recipe(item_name) {
        if (collapsed.has(item_name)) return false;
        var rec = active_recipe(item_name);
        return rec && rec.mats && Object.keys(rec.mats).length > 0;
    }

    function populate_game_select() {
        for (var id in GAMES) {
            game_select.append(`<option value="${id}">${GAMES[id].label}</option>`);
        }
    }

    function populate_select() {
        item_select.empty();
        item_select.append('<option></option>');
        for (var key in items) {
            item_select.append(`<option>${key}</option>`);
        };
    }

    function update_url() {
        var params = new URLSearchParams();
        params.set('game', current_game);
        var item = item_select.val();
        if (item) {
            params.set('item', item);
        }
        history.replaceState(null, '', '?' + params.toString());
    }

    function format_num(value) {
        return Math.floor(value * 100) / 100;
    }

    function get_url_params() {
        var vars = {};
        new URLSearchParams(window.location.search).forEach(function(value, key) {
            vars[key] = value;
        });
        return vars;
    }

    init();
});