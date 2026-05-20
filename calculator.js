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
    var craft_tree_display = $("#craft_tree");
    var graph_display = $("#graph");

    function show_item_details() {
        var item = items[item_select.val()];

        materials_display.empty();
        craft_tree_display.empty();

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

        add_header(craft_tree_display, "Material Tree");
        show_item_materials(item, 1, '');

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

    function show_item_materials(item, multiplier, spacers) {
        var keys = item.mats ? Object.keys(item.mats) : [];
        for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
            var sub_item = items[key];

            var first_item = i === 0;
            var last_item = i === keys.length - 1;

            craft_tree_display.append(first_item && spacers.length >= 3 ? spacers.slice(0, -3) + '-->' : spacers, `${key}: ${format_num(item.mats[key] * multiplier)}`, '<br />');
            craft_tree_display.append(spacers, (last_item && !sub_item) ? ' ' : '|', '<br />');

            if (sub_item) {
                show_item_materials(sub_item, multiplier * item.mats[key], spacers + (last_item ? '   ' : '|  '));
            }
        }
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
                materials_display.empty();
                craft_tree_display.empty();
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

    function makeGraph(item) {
        return new sigma({
            renderer: {
                container: graph_display[0],
                type: 'canvas'
            },
            settings: {
                minArrowSize: 7,
                sideMargin: 1,
                mouseWheelEnabled: false,
                mouseEnabled: false,
            },
            graph: {
                nodes: makeNodes(item.name, {}, true),
                edges: makeEdges(item.name, {}),
            },
        });
    }

    function makeNodes(item_name, nodes, first_node = false) {
        if (nodes[item_name] === undefined) {
            var color = "black";
            if (first_node) {
                color = "red";
            } else if (!items[item_name]) {
                color = "blue";
            }
            nodes[item_name] = {
                id: item_name,
                label: item_name,
                x: Math.random(),
                y: Math.random(),
                size: 1,
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
                        size: 1,
                        color: "black",
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