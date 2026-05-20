$(function() {
    var graph;
    var graph_force_timeout;

    var GAMES = {
        factorio: { label: 'Factorio', file: './data/factorio.json' },
        dyson: { label: 'Dyson Sphere Program', file: './data/dyson.json' },
    };
    var DEFAULT_GAME = 'factorio';
    var current_game = DEFAULT_GAME;

    var items = {};
    var hide_items = [];
    var game_select = $("#game_select");
    var item_select = $("#item_select");
    var per_sec_input = $("#items_per_sec");
    var material_detail_checkbox = $("#show_material_details");
    var materials_display = $("#materials");
    var graph_display = $("#graph");

    // Picker (in-game-style item browser). Available when the active game's
    // data carries layout fields (category/row/col/icon on each entry) —
    // today that's DSP only. Factorio data has no icons; picker_btn stays
    // hidden and the dropdown is the only chooser.
    var open_picker_btn = $("#open_picker");
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

        materials_display.empty();

        total_materials = calculate_total_materials(item);

        add_header(materials_display, "Total Materials");
        var per_sec = per_sec_input.val() || 1;

        add_sub_header(materials_display, "Raw");
        for (var mat_key in total_materials.raw) {
            if (hide_items.indexOf(mat_key) !== -1) {
                continue;
            }
            materials_display.append(`${hide_material_button(mat_key)}${mat_key}: ${format_num(total_materials.raw[mat_key] * per_sec)}<br />`);
            if (material_detail_checkbox.is(":checked")) {
                materials_display.append(`Goes into ${generate_mat_used_for_list(mat_key, item)}<br /><br />`);
            }
        }

        for (var mat_key in total_materials.built) {
            if (hide_items.indexOf(mat_key) !== -1) {
                continue;
            }
            add_sub_header(materials_display, hide_material_button(mat_key) + mat_key)
            materials_display.append(`Count:            ${format_num(total_materials.built[mat_key] * per_sec)}<br />`);
            if (items[mat_key] && items[mat_key].time) {
                var production_units = total_materials.built[mat_key] * items[mat_key].time * per_sec;
                materials_display.append(`Production Units: ${format_num(production_units)}`);
                if (material_detail_checkbox.is(":checked")) {
                    materials_display.append(
                        '<br />',
                        `0.50 x ${format_num(production_units / 0.5)} <br />`,
                        `0.75 x ${format_num(production_units / 0.75)} <br />`,
                        `1.00 x ${format_num(production_units / 1)} <br />`,
                        `1.25 x ${format_num(production_units / 1.25)} <br />`,
                        `2.00 x ${format_num(production_units / 2)} <br />`
                    );
                    materials_display.append(`Goes into ${generate_mat_used_for_list(mat_key, item)}<br />`);
                }
            }
        }

        if (hide_items.length > 0) {
            add_sub_header(materials_display, "Hidden Materials");
        }
        for (var i = 0; i < hide_items.length; i++) {
            materials_display.append(`${show_material_button(hide_items[i])}${hide_items[i]}<br />`);
        }

        $(".hide.button").on('click', function(ele) {
            hide_items.push($(this).attr("data-material"));
            show_item_details();
        });

        $(".show.button").on('click', function(ele) {
            hide_items.splice(hide_items.indexOf($(this).attr("data-material")), 1);
            show_item_details();
        });

        render_graph(item);
    }

    function render_graph() {
        var item = items[item_select.val()];
        graph_display.empty();
        add_header(graph_display, "Material Graph");
        graph = makeGraph(item);
        graph.startForceAtlas2();
        clearTimeout(graph_force_timeout);
        graph_force_timeout = window.setTimeout(function() { graph.killForceAtlas2() }, 3000);
    }

    function calculate_total_materials(item) {
        var total_materials = { raw: {}, built: {} };
        total_materials.built[item.name] = 1;

        function count_material_list(mats, multiplier) {
            for (var mat_key in mats) {
                var total_needed = mats[mat_key] * multiplier;

                if (items[mat_key]) {
                    total_materials.built[mat_key] = total_materials.built[mat_key] || 0;
                    total_materials.built[mat_key] += total_needed;
                    count_material_list(items[mat_key].mats, total_needed);
                } else {
                    total_materials.raw[mat_key] = total_materials.raw[mat_key] || 0;
                    total_materials.raw[mat_key] += total_needed;
                }
            }
        }

        count_material_list(item.mats, 1);

        return total_materials;
    }

    function generate_mat_used_for_list(material, item) {
        var found_parents = [];

        function traverse_mat_tree(item) {
            for (var mat_key in item.mats) {
                if (mat_key === material) {
                    found_parents.push(item.name);
                }
                var item_mat = items[mat_key];
                if (item_mat) {
                    traverse_mat_tree(item_mat);
                }
            }
        }
        traverse_mat_tree(item);
        found_parents = [...new Set(found_parents)];
        return found_parents.length === 0 ? 'nothing' : found_parents.join(', ');
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

    function compute_picker_icon_size() {
        // Fit the widest row (14 items) into the panel's grid area.
        // Constants here mirror the CSS: side panel 240, grid padding 14
        // each side, panel border 1 each side, separator 1, item gap 4.
        // Math: usable_grid_w = panel_w - side - grid_padding*2 - borders;
        // tile_w = (usable_grid_w - gap*(WIDEST-1)) / WIDEST. Clamp 36-64.
        var WIDEST = 14;
        var PANEL_OVERHEAD = 240 + 14 * 2 + 2 + 1;  // = 271
        var GAP = 4;
        var panel_max = Math.min(window.innerWidth * 0.95, 1280);
        var grid_inner = panel_max - PANEL_OVERHEAD;
        var size = Math.floor((grid_inner - GAP * (WIDEST - 1)) / WIDEST);
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
        var rows = {};
        for (var k in items) {
            var e = items[k];
            if (e.category !== picker_active_tab) continue;
            (rows[e.row] = rows[e.row] || []).push({ key: k, entry: e });
        }
        picker_grid_el.empty();
        Object.keys(rows).map(Number).sort(function(a, b) { return a - b; })
            .forEach(function(rnum) {
                var row = rows[rnum].sort(function(a, b) {
                    return a.entry.col - b.entry.col;
                });
                var rowEl = $('<div class="picker-row"></div>');
                row.forEach(function(it) {
                    // Tile box size is set by --icon-size (CSS); the sprite
                    // scales with it; the per-tile position is the
                    // 64-px-cell value scaled to match (factor = size/64).
                    var factor = picker_icon_size / 64;
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
        if (picker_grid_el.children().length > 0) render_picker_grid();
    }

    function open_picker() {
        if (!picker_available()) return;
        var cats = picker_categories();
        if (cats.length === 0) return;
        if (!picker_active_tab || cats.indexOf(picker_active_tab) === -1) {
            // Prefer 'components' as the initial tab — users are more
            // likely to plan production of components than buildings.
            // Whichever tab the user clicks next is remembered for the
            // rest of the session (picker_active_tab persists across
            // close/open), but resets back to this when the active game
            // changes (different games have different category sets).
            picker_active_tab = cats.indexOf('components') !== -1
                ? 'components'
                : cats[0];
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
        // Show the open-picker button only when the active game ships layout.
        if (picker_available()) {
            open_picker_btn.removeAttr('hidden');
        } else {
            open_picker_btn.attr('hidden', '');
        }
    }

    // ---------- end picker ----------------------------------------------

    function load_game(game_id) {
        current_game = GAMES[game_id] ? game_id : DEFAULT_GAME;
        game_select.val(current_game);
        localStorage.setItem('last_game', current_game);

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
                hide_items = [];
                populate_select();
                update_picker_button();
                close_picker();  // close stale picker if game changed mid-open
                materials_display.empty();
                graph_display.empty();
            })
            .catch(function(err) {
                items = {};
                populate_select();
                materials_display.empty().append(
                    `<h2>Could not load ${current_game} data</h2>`,
                    `<p>${err.message}. If you opened this file directly, serve it ` +
                    `(e.g. <code>python3 -m http.server</code>) &mdash; fetch() is blocked on file://.</p>`
                );
            });
    }

    function init() {
        populate_game_select();

        item_select.change(function() {
            localStorage.setItem('last_item', this.value);
            hide_items = [];
            update_url();
            show_item_details();
        });
        per_sec_input.change(show_item_details);
        per_sec_input.keypress(function(e) {
            e.stopPropagation();
        });
        material_detail_checkbox.change(show_item_details);

        game_select.change(function() {
            load_game(this.value).then(function() {
                item_select.val('');
                update_url();
            });
        });

        // Picker wiring: open via button, close via × / backdrop / Esc. The
        // backdrop click only fires when the user clicks the OVERLAY itself
        // (not bubbled from the panel), which is the conventional dismiss.
        open_picker_btn.on('click', open_picker);
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

        load_game(start_game).then(function() {
            var selected_item = params['item'] || localStorage.getItem('last_item');
            if (selected_item && items[selected_item]) {
                item_select.val(selected_item);
                item_select.change();
            } else {
                update_url();
            }
        });
    }

    // Graph palette: warm gold for the selected root, vivid green for raw
    // resources (semantic fit + distinct hue family), muted slate for
    // intermediates (recedes between the two emphasis colors), mid-blue
    // edges. Cyan was here for raw before but read as a sibling to the
    // slate intermediates against the navy panel — green/slate/gold is a
    // clean three-hue split.
    var GRAPH_COLOR_SELECTED  = '#ffc857';   // gold — the root
    var GRAPH_COLOR_RAW       = '#5cf089';   // vivid green — raw resources
    var GRAPH_COLOR_DEFAULT   = '#7a99b8';   // muted slate — intermediates
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
                mouseWheelEnabled: false,
                mouseEnabled: false,
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
            // "Raw" = the item bottoms out the material tree: either no
            // entry at all (older datasets) or an entry with no `mats`
            // (DSP raw resources are first-class picker entries now —
            // iron ore, water, crude oil — so a bare absence check would
            // mis-color them as intermediates).
            var entry = items[item_name];
            var is_raw = !entry || !entry.mats
                || Object.keys(entry.mats).length === 0;
            var color = GRAPH_COLOR_DEFAULT;
            if (first_node) {
                color = GRAPH_COLOR_SELECTED;
            } else if (is_raw) {
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
            if (items[item_name]) {
                for (var mat_key in items[item_name].mats) {
                    makeNodes(mat_key, nodes);
                }
            }
        }
        return Object.values(nodes);
    }

    function makeEdges(item_name, edges) {
        if (items[item_name]) {
            var item = items[item_name];
            for (var mat_key in item.mats) {
                item_mat = items[mat_key];
                edge_name = mat_key + "->" + item.name;
                if (edges[edge_name] === undefined) {
                    edges[edge_name] = {
                        id: edge_name,
                        source: mat_key,
                        target: item.name,
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
        for (var main_item_key in items) {
            var main_item = items[main_item_key];
            main_item.name = main_item_key;
            if (main_item.produced === undefined) {
                main_item.produced = 1;
            }
            main_item.time /= main_item.produced;
            for (var material_key in main_item.mats) {
                main_item.mats[material_key] /= main_item.produced;
            }
        }
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

    function add_header(element, text) {
        element.append(`<h2>${text}</h2>`);
    }

    function add_sub_header(element, text) {
        element.append(`<h3>${text}</h3>`);
    }

    function hide_material_button(material) {
        return `<div class='hide button' data-material='${material}')'></div>`;
    }

    function show_material_button(material) {
        return `<div class='show button' data-material='${material}')'></div>`;
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