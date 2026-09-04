frappe.ui.form.on("Web Form", {
	setup: function () {
		frappe.meta.docfield_map["Web Form Field"].fieldtype.formatter = (value) => {
			const prefix = {
				"Page Break": "--red-600",
				"Section Break": "--blue-600",
				"Column Break": "--yellow-600",
			};
			if (prefix[value]) {
				value = `<span class="bold" style="color: var(${prefix[value]})">${value}</span>`;
			}
			return value;
		};

		frappe.meta.docfield_map["Web Form Field"].fieldname.formatter = (value) => {
			if (!value) return;
			return frappe.unscrub(value);
		};

		frappe.meta.docfield_map["Web Form List Column"].fieldname.formatter = (value) => {
			if (!value) return;
			return frappe.unscrub(value);
		};
	},

	refresh: function (frm) {
		frm.embed_link && frm.embed_link.remove();

		// get iframe url for web form
		frm.embed_link = frm.sidebar
			.add_user_action(__("Copy embed code"))
			.attr("href", "#")
			.on("click", () => {
				const url = frappe.urllib.get_full_url(frm.doc.route);
				const code = `<iframe src="${url}" style="border: none; width: 100%; height: inherit;"></iframe>`;
				frappe.utils.copy_to_clipboard(code, __("Embed code copied"));
			});

		if (frm.doc.is_standard && !frappe.boot.developer_mode) {
			frm.disable_form();
			frappe.show_alert(
				__("Standard Web Forms can not be modified, duplicate the Web Form instead.")
			);
		}
		on_controlled_access_change(frm);

		frm.trigger("set_fields");
		frm.trigger("add_get_fields_button");
		frm.trigger("add_publish_button");
		frm.trigger("render_condition_table");
		frm.trigger("render_dynamic_filters_table");
		render_form_builder(frm);
	},

	login_required: on_controlled_access_change,

	key_required: on_controlled_access_change,

	anonymous: function (frm) {
		if (frm.doc.anonymous) {
			frm.set_value("login_required", 0);
		}
	},

	on_tab_change: (frm) => {
		let current_tab = frm.get_active_tab().label;
		let on_form_tab = current_tab === "Form";

		if (on_form_tab) {
			frm.footer.wrapper.hide();
			frm.form_wrapper.find(".form-message").hide();
			frm.form_wrapper.addClass("mb-1");
		} else {
			frm.footer.wrapper.show();
			frm.form_wrapper.find(".form-message").show();
			frm.form_wrapper.removeClass("mb-1");
		}

		toggle_form_sidebar(frm, !on_form_tab);
	},

	validate: function (frm) {
		flush_form_builder(frm);

		// allow_delete is hidden (depends_on allow_multiple) and would otherwise
		// retain a stale value while server-side checks read it directly.
		!frm.doc.allow_multiple && frm.set_value("allow_delete", 0);
		frm.doc.allow_multiple && frm.set_value("show_list", 1);

		if (!frm.doc.web_form_fields) {
			frm.scroll_to_field("web_form_fields");
			frappe.throw(__("At least one field is required in Web Form Fields Table"));
		}

		let page_break_count = frm.doc.web_form_fields.filter(
			(f) => f.fieldtype == "Page Break"
		).length;

		if (page_break_count >= 10) {
			frappe.throw(__("There can be only 9 Page Break fields in a Web Form"));
		}
	},

	add_publish_button(frm) {
		frm.add_custom_button(frm.doc.published ? __("Unpublish") : __("Publish"), () => {
			frm.set_value("published", !frm.doc.published);
			frm.save();
		});
	},

	add_get_fields_button(frm) {
		frm.add_custom_button(__("Get Fields"), () => {
			let webform_fieldtypes = frappe.meta
				.get_field("Web Form Field", "fieldtype")
				.options.split("\n");

			get_fields_for_doctype(frm.doc.doc_type).then((fields) => {
				// Fields already on the web form are deliberately NOT filtered out: the dialog
				// lists everything in one region with these pre-checked, and unchecking one
				// removes it from the form.
				let importable_fields = fields.filter((df) => {
					let fieldtype = df.fieldtype == "Tab Break" ? "Page Break" : df.fieldtype;
					return webform_fieldtypes.includes(fieldtype) && !df.hidden;
				});

				if (!importable_fields.length && !(frm.doc.web_form_fields || []).length) {
					frappe.msgprint(__("No fields are available from {0}.", [frm.doc.doc_type]));
					return;
				}

				show_get_fields_dialog(frm, importable_fields);
			});
		});
	},

	set_fields(frm) {
		let doc = frm.doc;

		let as_select_option = (df) => ({
			label: df.label,
			value: df.fieldname,
		});
		let update_options = (fields) => {
			frm.fields_dict.web_form_fields.grid.update_docfield_property(
				"fieldname",
				"options",
				fields.map(as_select_option)
			);
			frm.fields_dict.list_columns.grid.update_docfield_property(
				"fieldname",
				"options",
				fields
					.filter(
						(df) =>
							!frappe.model.no_value_type.includes(df.fieldtype) &&
							df.is_virtual !== 1
					)
					.map(as_select_option)
			);
		};

		if (!doc.doc_type) {
			update_options([]);
			frm.set_df_property("amount_field", "options", []);
			return;
		}

		update_options([
			{ label: __("Fetching fields from {0}...", [doc.doc_type]), fieldname: "" },
		]);

		get_fields_for_doctype(doc.doc_type).then((fields) => {
			update_options(fields);

			let currency_fields = fields
				.filter((df) => ["Currency", "Float"].includes(df.fieldtype))
				.map(as_select_option);
			if (!currency_fields.length) {
				currency_fields = [
					{
						label: __("No currency fields in {0}", [doc.doc_type]),
						value: "",
						disabled: true,
					},
				];
			}
			frm.set_df_property("amount_field", "options", currency_fields);
		});
	},

	title: function (frm) {
		if (frm.doc.__islocal) {
			var page_name = frm.doc.title.toLowerCase().replace(/ /g, "-");
			frm.set_value("route", page_name);
		}
	},

	doc_type: function (frm) {
		frm.trigger("set_fields");
		render_form_builder(frm);
	},

	allow_multiple: function (frm) {
		frm.doc.allow_multiple && frm.set_value("show_list", 1);
	},

	after_save: function (frm) {
		frappe.web_form_builder?.store?.fetch();
	},

	before_save: function (frm) {
		let dynamic_filters = JSON.parse(frm.doc.dynamic_filters_json || "null");
		let static_filters = JSON.parse(frm.doc.condition_json || "[]");
		static_filters = frappe.dashboard_utils.remove_common_static_filter_values(
			static_filters,
			dynamic_filters
		);
		frm.set_value("condition_json", JSON.stringify(static_filters));
		frm.trigger("render_condition_table");
		frm.trigger("render_dynamic_filters_table");
	},

	render_condition_table: function (frm) {
		let wrapper = $(frm.get_field("condition_json").wrapper).empty();
		let table = $(`
			<style>
			.table-bordered th, .table-bordered td {
				border: none;
				border-right: 1px solid var(--border-color);
			}
			.table-bordered td {
				border-top: 1px solid var(--border-color);
			}
			.table thead th {
				border-bottom: none;
				font-weight: var(--weight-regular);
			}
			tr th:last-child, tr td:last-child{
				border-right: none;
			}
			thead {
				font-size: var(--text-sm);
				color: var(--gray-600);
				background-color: var(--subtle-fg);
			}
			thead th:first-child {
				border-top-left-radius: 9px;
			}
			thead th:last-child {
				border-top-right-radius: 9px;
			}
			</style>

			<table class="table table-bordered" style="cursor:pointer; margin:0px; border-radius: 10px; border-spacing: 0; border-collapse: separate;">
			<thead>
				<tr>
					<th>${__("Filter")}</th>
					<th style="width: 20%">${__("Condition")}</th>
					<th>${__("Value")}</th>
				</tr>
			</thead>
			<tbody></tbody>
		</table>`).appendTo(wrapper);
		$(`<p class="text-muted small mt-2">${__("Click table to edit")}</p>`).appendTo(wrapper);

		let filters = JSON.parse(frm.doc.condition_json || "[]");
		let filters_set = false;

		let fields = [
			{
				fieldtype: "HTML",
				fieldname: "filter_area",
			},
		];

		if (filters?.length) {
			filters.forEach((filter) => {
				const filter_row = $(`<tr>
							<td>${filter[1]}</td>
							<td>${filter[2] || ""}</td>
							<td>${filter[3]}</td>
						</tr>`);

				table.find("tbody").append(filter_row);
			});
			filters_set = true;
		}

		if (!filters_set) {
			const filter_row = $(`<tr><td colspan="3" class="text-muted text-center">
				${__("Click to Set Filters")}</td></tr>`);
			table.find("tbody").append(filter_row);
		}

		table.on("click", () => {
			let dialog = new frappe.ui.Dialog({
				title: __("Set Filters"),
				fields: fields,
				primary_action: function () {
					let values = this.get_values();
					if (values) {
						this.hide();
						let filters = frm.filter_group.get_filters();
						frm.set_value("condition_json", JSON.stringify(filters));
						frm.trigger("render_condition_table");
					}
				},
				primary_action_label: "Set",
			});

			frm.filter_group = new frappe.ui.FilterGroup({
				parent: dialog.get_field("filter_area").$wrapper,
				doctype: frm.doc.doc_type,
				on_change: () => {},
			});
			filters && frm.filter_group.add_filters_to_filter_group(filters);

			dialog.show();

			dialog.set_values(filters);
		});
	},
	render_dynamic_filters_table(frm) {
		let wrapper = $(frm.get_field("dynamic_filters_json").wrapper).empty();

		frm.dynamic_filter_table = $(`<table class="table table-bordered" style="cursor:${
			frm.has_perm("write") ? "pointer" : "default"
		}; margin:0px;">
			<thead>
				<tr>
					<th style="width: 20%">${__("Filter")}</th>
					<th style="width: 20%">${__("Condition")}</th>
					<th>${__("Value")}</th>
				</tr>
			</thead>
			<tbody></tbody>
		</table>`).appendTo(wrapper);

		frm.dynamic_filters =
			frm.doc.dynamic_filters_json && frm.doc.dynamic_filters_json.length > 2
				? JSON.parse(frm.doc.dynamic_filters_json)
				: null;

		frm.trigger("set_dynamic_filters_in_table");

		let filters = JSON.parse(frm.doc.condition_json || "[]");

		let fields = frappe.dashboard_utils.get_fields_for_dynamic_filter_dialog(
			true,
			filters,
			frm.dynamic_filters
		);

		// Override description to show Python expressions (evaluated server-side)
		let desc_field = fields.find((f) => f.fieldname === "description");
		if (desc_field) {
			desc_field.options = `<div>
				<p>${__("Set dynamic filter values as Python expressions.")}</p>
				<p>${__("For example:")}
					<code>frappe.session.user</code> ${__("or")}
					<code>frappe.utils.now()</code>
				</p>
			</div>`;
		}

		frm.dynamic_filter_table.on("click", () => {
			if (!frm.has_perm("write")) {
				return;
			}

			if (!frappe.boot.developer_mode && frm.doc.is_standard) {
				frappe.throw(__("Cannot edit filters for standard Web Forms"));
			}
			let dialog = new frappe.ui.Dialog({
				title: __("Set Dynamic Filters"),
				fields: fields,
				primary_action: () => {
					let values = dialog.get_values();
					dialog.hide();
					let dynamic_filters = [];
					for (let key of Object.keys(values)) {
						let [doctype, fieldname] = key.split(":");
						dynamic_filters.push([doctype, fieldname, "=", values[key]]);
					}
					frm.set_value("dynamic_filters_json", JSON.stringify(dynamic_filters));
					frm.trigger("set_dynamic_filters_in_table");
				},
				primary_action_label: __("Set"),
			});

			dialog.show();
			if (frm.dynamic_filters) {
				let filter_values = {};
				frm.dynamic_filters.forEach((f) => {
					filter_values[f[0] + ":" + f[1]] = f[3];
				});
				dialog.set_values(filter_values);
			}
		});
	},
	set_dynamic_filters_in_table: function (frm) {
		frm.dynamic_filters =
			frm.doc.dynamic_filters_json && frm.doc.dynamic_filters_json.length > 2
				? JSON.parse(frm.doc.dynamic_filters_json)
				: null;

		if (!frm.dynamic_filters) {
			const filter_row = $(`<tr><td colspan="3" class="text-muted text-center">
				${__("Click to Set Dynamic Filters")}</td></tr>`);
			frm.dynamic_filter_table.find("tbody").html(filter_row);
		} else {
			let filter_rows = "";
			frm.dynamic_filters.forEach((filter) => {
				filter_rows += `<tr>
						<td>${filter[1]}</td>
						<td>${filter[2] || ""}</td>
						<td>${filter[3]}</td>
					</tr>`;
			});
			frm.dynamic_filter_table.find("tbody").html(filter_rows);
		}
	},
});

frappe.ui.form.on("Web Form List Column", {
	fieldname: function (frm, doctype, name) {
		let doc = frappe.get_doc(doctype, name);
		let df = frappe.meta.get_docfield(frm.doc.doc_type, doc.fieldname);
		if (!df) return;
		doc.fieldtype = df.fieldtype;
		doc.label = df.label;
		doc.options = df.options;
		frm.refresh_field("list_columns");
	},
});

frappe.ui.form.on("Web Form Field", {
	fieldtype: function (frm, doctype, name) {
		let doc = frappe.get_doc(doctype, name);

		if (doc.fieldtype == "Page Break") {
			let page_break_count = frm.doc.web_form_fields.filter(
				(f) => f.fieldtype == "Page Break"
			).length;
			page_break_count >= 10 &&
				frappe.throw(__("There can be only 9 Page Break fields in a Web Form"));
		}

		if (["Section Break", "Column Break", "Page Break"].includes(doc.fieldtype)) {
			doc.fieldname = "";
			doc.label = "";
			doc.options = "";
			frm.refresh_field("web_form_fields");
		}
	},
	fieldname: function (frm, doctype, name) {
		let doc = frappe.get_doc(doctype, name);
		let df = frappe.meta.get_docfield(frm.doc.doc_type, doc.fieldname);
		if (!df) return;

		doc.label = df.label;
		doc.fieldtype = df.fieldtype;
		doc.options = df.options;
		doc.reqd = df.reqd;
		doc.default = df.default;
		doc.read_only = df.read_only;
		doc.depends_on = df.depends_on;
		doc.placeholder = df.placeholder;
		doc.description = df.description;
		doc.mandatory_depends_on = df.mandatory_depends_on;
		doc.max_length = df.length;
		doc.read_only_depends_on = df.read_only_depends_on;

		frm.refresh_field("web_form_fields");
	},
});

function show_get_fields_dialog(frm, fields) {
	let fields_by_name = Object.fromEntries(fields.map((df) => [df.fieldname, df]));
	let existing_rows = frm.doc.web_form_fields || [];
	let existing_fieldnames = existing_rows.map((d) => d.fieldname);

	// Everything the dialog can offer, existing rows first in doc order. A row whose source
	// docfield has since been deleted still gets listed, so unchecking it stays possible.
	let all_fieldnames = existing_fieldnames.concat(
		fields.map((df) => df.fieldname).filter((f) => !existing_fieldnames.includes(f))
	);

	// A DocType routinely leaves `label` blank when it is derivable from the fieldname, so the
	// source docfield is NOT the reliable place to read one from - the Web Form Field row often
	// carries a real label where the docfield has "". Take whichever actually has one, then fall
	// back to unscrubbing the fieldname, the same way the Web Form Field grid renders it above.
	let label_for = (fieldname) => {
		let row = existing_rows.find((d) => d.fieldname === fieldname);
		let df = fields_by_name[fieldname];
		let label = row?.label || df?.label;
		if (label) return __(label);
		if (fieldname) return frappe.unscrub(fieldname);
		return `[${__(df?.fieldtype || row?.fieldtype)}]`;
	};

	// One flat list, in `all_fieldnames` order (existing fields first). Checked state is read
	// straight off the checkboxes on Update via dialog.get_field("fields").get_value() -
	// there's no separate "selected_fieldnames" tracking variable to keep in sync with the DOM,
	// unlike the old two-region version which had to move fields between two option arrays.
	let get_field_options = () =>
		all_fieldnames.map((fieldname) => {
			let df = fields_by_name[fieldname];
			return {
				label: label_for(fieldname),
				value: fieldname,
				checked: existing_fieldnames.includes(fieldname),
				description: df?.fieldtype,
				danger: !!df?.reqd,
				warning: !!(
					df?.depends_on ||
					df?.mandatory_depends_on ||
					df?.read_only_depends_on
				),
				warning_title: df ? get_depends_on_warning_title(df) : "",
			};
		});

	let dialog = new frappe.ui.Dialog({
		title: __("Get Fields from {0}", [frm.doc.doc_type]),
		// Dialog autofocuses the first field that can take focus (field_group.js
		// focus_on_first_input), which here would be the search box - fine to leave focused,
		// unlike a bulk-action button that would otherwise wear a focus ring as if pre-pressed.
		fields: [
			{
				// No label here - the heading text sits inside picker_header below the search
				// box instead, matching where Data Import's Export dialog puts its own
				// section_title relative to its search box.
				fieldtype: "Section Break",
			},
			// Search box, heading and bulk-action buttons all live in this HTML field, a
			// *sibling* of the MultiCheck rather than a child of it - the same arrangement as
			// Data Import's Export dialog (data_exporter.js select_all_buttons). That placement
			// is load-bearing here: only the MultiCheck below scrolls, and an input inside a
			// scroll container gets its focus ring clipped (see below).
			{
				fieldtype: "HTML",
				fieldname: "picker_header",
			},
			{
				fieldname: "fields",
				fieldtype: "MultiCheck",
				columns: 2,
				sort_options: false,
				options: get_field_options(),
			},
		],
		primary_action_label: __("Update"),
		primary_action: () => {
			let selected_fieldnames = dialog.get_field("fields").get_value();

			// Rows the user unchecked are dropped. clear_doc() also drops them from `locals` and
			// renumbers the remaining idx, which a bare array filter would not.
			existing_rows
				.filter((d) => !selected_fieldnames.includes(d.fieldname))
				.forEach((d) => frappe.model.clear_doc(d.doctype, d.name));

			// Rows left checked are untouched rather than recreated, so any customisation made
			// on them (custom label, overridden reqd, ...) survives a trip through this dialog.
			selected_fieldnames
				.filter((fieldname) => !existing_fieldnames.includes(fieldname))
				.forEach((fieldname) => {
					let df = fields_by_name[fieldname];
					if (!df) return;

					let fieldtype = df.fieldtype == "Tab Break" ? "Page Break" : df.fieldtype;
					let dependencies = resolve_field_dependencies(df, selected_fieldnames);

					frm.add_child("web_form_fields", {
						fieldname: df.fieldname,
						label: df.label,
						fieldtype: fieldtype,
						options: df.options,
						reqd: df.reqd,
						default: df.default,
						read_only: df.read_only,
						precision: df.precision,
						placeholder: df.placeholder,
						max_length: df.length,
						description: df.description,
						...dependencies,
					});
				});

			frm.refresh_field("web_form_fields");
			frappe.web_form_builder?.store?.fetch();

			// Land on the form builder rather than the raw child table - the builder is where
			// the picked fields are actually arranged, and it lives in a different tab.
			// Deliberately NOT frm.scroll_to_field("form_builder"): that helper always tags the
			// enclosing .frappe-control with `highlight` for 2s (form.js), and
			// --highlight-shadow is a blue glow sized for flashing a single input - around the
			// full-tab builder it reads as a giant blue halo. There is no opt-out flag, and
			// there is nothing to scroll to here anyway, so activate the tab directly.
			get_form_builder_tab(frm)?.set_active();
			dialog.hide();
		},
	});

	// Search box on top, heading below it, bulk-action buttons last - the same order as Data
	// Import's Export dialog (data_exporter.js setup_search_input + make_select_all_buttons),
	// but deliberately NOT its `input-xs`/`btn-xs`/`uppercase` classes. Everything here is left
	// at the desk's standard --text-base (14px), matching the checkbox labels below and section
	// heads in other dialogs: `.btn-xs` overrides its inherited size down to --text-xs (12px)
	// (global.scss), and `.input-xs` squeezes a 14px input into a 26px box. The h6's weight is
	// forced back to normal because a bold heading directly under the dialog's own title reads
	// as a second title - that bold comes from Bootstrap's reboot, not from any Frappe rule
	// (global.scss only bolds h1-h3, .form-section-heading just sets a small-breakpoint margin).
	// The heading's muted color is restored by hand for the same reason the size is: `.uppercase`
	// (global.scss) is not just a text-transform - it also carries color: var(--text-muted) and
	// shrinks to --text-sm, so dropping it to lose the all-caps took the gray with it.
	let $header = dialog.get_field("picker_header").$wrapper;
	$header.html(`
		<div class="filters-search">
			<input
				type="text"
				placeholder="${__("Search")}"
				data-element="search"
				class="form-control"
			>
		</div>
		<h6
			class="form-section-heading"
			style="font-weight: normal; font-size: var(--text-base); margin-bottom: var(--margin-sm); color: var(--text-muted);"
		>
			${__("Select Fields To Update")}
		</h6>
		<div class="mb-3">
			<button class="btn btn-default btn-sm" data-action="select_all">${__("Select All")}</button>
			<button class="btn btn-default btn-sm" data-action="unselect_all">${__("Unselect All")}</button>
		</div>
	`);

	// Toggling the inputs and firing "change" is what MultiCheck's own bind_checkboxes() listens
	// for, so its selected_options - and therefore get_value() on Update - stays in sync
	// without reaching into the control's internals. Same approach as data_exporter.js.
	let set_all_checked = (checked) =>
		dialog.$wrapper.find(":checkbox").prop("checked", checked).trigger("change");
	$header.find('[data-action="select_all"]').on("click", () => set_all_checked(true));
	$header.find('[data-action="unselect_all"]').on("click", () => set_all_checked(false));

	// The generic frappe.utils.setup_search utility filters any ".unit-checkbox" it finds by the
	// text in its ".label-area", which is exactly what MultiCheck renders per option, so no
	// per-dialog search logic is needed here.
	dialog.on_page_show = () =>
		frappe.utils.setup_search(dialog.$body, ".unit-checkbox", ".label-area");

	// Constant height so the dialog does not resize as the search filters fields in and out. Only
	// the checkbox list scrolls - the search box deliberately sits outside this element, because
	// Bootstrap draws input focus rings as a box-shadow spreading ~3px OUTSIDE the border box
	// ($input-focus-box-shadow), which an overflow container crops on every edge it touches.
	// The height also goes on the control wrapper, NOT on .checkbox-options itself: that element
	// is a CSS multi-column box (templates/styles/standard.css sets `columns`), and constraining
	// a column box's height makes overflow spill into extra columns sideways instead of scrolling
	// down. Left to size itself it balances into its 2 columns and grows downwards, which is what
	// the wrapper then scrolls.
	// h-80 is 320px (utilities.scss $h-steps x --spacing 0.25rem) - roughly 22 fields visible
	// across the 2 columns. Frappe puts no ceiling on dialog height (Dialog's `size` sets width
	// only), so this number is ours to pick; 320px still leaves the whole dialog near 520px tall
	// with its chrome, which fits a laptop viewport without the modal itself needing to scroll.
	dialog.get_field("fields").$wrapper.addClass("h-80 overflow-y-auto");

	dialog.show();
}

function get_depends_on_warning_title(df) {
	let condition = df.depends_on || df.mandatory_depends_on || df.read_only_depends_on;
	return condition ? __("Depends on: {0}", [condition]) : "";
}

function get_referenced_fieldnames(condition) {
	if (!condition) return [];
	let matches = condition.match(/doc\.(\w+)/g) || [];
	return matches.map((m) => m.replace("doc.", ""));
}

function condition_survives(condition, selected_fieldnames) {
	let referenced = get_referenced_fieldnames(condition);
	return referenced.length > 0 && referenced.every((f) => selected_fieldnames.includes(f));
}

function resolve_field_dependencies(df, selected_fieldnames) {
	let result = {};

	if (condition_survives(df.depends_on, selected_fieldnames)) {
		result.depends_on = df.depends_on;
	}
	if (condition_survives(df.mandatory_depends_on, selected_fieldnames)) {
		result.mandatory_depends_on = df.mandatory_depends_on;
	}
	if (condition_survives(df.read_only_depends_on, selected_fieldnames)) {
		result.read_only_depends_on = df.read_only_depends_on;
	}
	return result;
}

function get_fields_for_doctype(doctype) {
	return new Promise((resolve) => frappe.model.with_doctype(doctype, resolve)).then(() => {
		return frappe.meta.get_docfields(doctype).filter((df) => {
			return (
				(frappe.model.is_value_type(df.fieldtype) &&
					!["lft", "rgt"].includes(df.fieldname)) ||
				["Table", "Table MultiSelect"].includes(df.fieldtype) ||
				frappe.model.layout_fields.includes(df.fieldtype)
			);
		});
	});
}

function get_form_builder_tab(frm) {
	return frm.layout?.tabs?.find((t) => t.df.fieldname === "form_builder_tab");
}

// The builder is a canvas - it wants the whole page width, so the form sidebar goes away while
// that tab is open. Hiding .layout-side-section is only half of it: page.scss sizes the main
// column as calc(100% - var(--form-sidebar-width)) for every body[data-route^="Form"], so the
// vacated strip would otherwise just sit there empty. Widening is done with inline styles and
// undone by clearing them (not by writing the old values back), which hands sizing back to that
// stylesheet rule rather than freezing today's formula into JS.
function toggle_form_sidebar(frm, show) {
	if (!frm.page?.sidebar) return;

	// Leave it alone when there is no sidebar to begin with: form.js already hid it for every
	// form in that case, and toggling it back on here would quietly override the setting. Same
	// condition the toolbar uses to decide whether to offer its own "Toggle Sidebar" item.
	if (frm.page.hide_sidebar || !frappe.boot.desk_settings?.form_sidebar) return;

	frm.page.sidebar.toggle(show);
	frm.page.wrapper.find(".layout-main-section-wrapper").css({
		width: show ? "" : "100%",
		flex: show ? "" : "1 0 100%",
	});
}

function keep_form_tab_visible(frm) {
	const tab = get_form_builder_tab(frm);
	if (!tab || tab._forced_visible) return;

	const original_refresh = tab.refresh.bind(tab);
	tab.refresh = function () {
		original_refresh();
		this.toggle(true);
	};
	tab._forced_visible = true;
	tab.toggle(true);
}

function render_form_builder(frm) {
	const field = frm.fields_dict["form_builder"];
	if (!field) return;

	keep_form_tab_visible(frm);
	const { $placeholder, $mount } = get_builder_containers($(field.wrapper));

	// frm is reused across records of this doctype (including "New"), so a
	// builder mounted for a previously-open form is still live on this wrapper.
	// Hide it instead of leaving the last form's layout on screen.
	$placeholder.toggle(!frm.doc.doc_type);
	$mount.toggle(!!frm.doc.doc_type);
	if (!frm.doc.doc_type) return;

	const builder = frappe.web_form_builder;
	if (!builder) return mount_form_builder(frm, $mount);
	if (!builder.store || builder.frm !== frm) return repoint_form_builder(builder, frm, $mount);

	sync_form_builder(builder, frm);
}

// The builder's Vue app must mount exactly once, and only while its store is
// still empty: it teleports its menus into an #autocomplete-area div declared
// at the end of its own template, so a remount that already has fields to draw
// would resolve those teleport targets before that div exists and silently
// leave every "Add field" button inert. Keeping the placeholder in a sibling
// node lets us toggle it without ever touching the node Vue owns.
function get_builder_containers(wrapper) {
	if (!wrapper.find(".form-builder-placeholder").length) {
		$(
			`<div class="form-builder-placeholder form-message blue">${__(
				"Select a DocType in the Details tab to start building this form."
			)}</div>`
		).appendTo(wrapper);
		$(`<div class="form-builder-mount">`).appendTo(wrapper);
	}

	return {
		$placeholder: wrapper.find(".form-builder-placeholder"),
		$mount: wrapper.find(".form-builder-mount"),
	};
}

// FormBuilder stores these under the same names it accepts them by, so one
// object serves both a fresh mount and a re-point of the existing instance.
function builder_options(frm) {
	return {
		doctype: frm.doc.doc_type,
		customize: false,
		is_layout: true,
		row_doctype: "Web Form Field",
		target_fieldname: "web_form_fields",
		force_read_only: is_read_only(frm),
		editable_props: ["label"],
		show_preview: false,
	};
}

function mount_form_builder(frm, wrapper) {
	if (frm._web_form_builder_loading) return;
	frm._web_form_builder_loading = true;

	frappe.require("form_builder.bundle.js").then(() => {
		frappe.web_form_builder = new frappe.ui.FormBuilder({
			wrapper,
			frm,
			...builder_options(frm),
		});
		frappe.web_form_builder.docname = frm.doc.name;
		frm._web_form_builder_loading = false;
	});
}

// Standard Web Forms are already frm.disable_form()'d; keep the builder in step.
function is_read_only(frm) {
	return Boolean(frm.doc.is_standard && !frappe.boot.developer_mode);
}

// Write the builder's layout back into web_form_fields before the form's own
// validations read it - validate() runs ahead of before_save(). The grid edits
// the same table, so only overwrite it when the builder itself was touched.
function flush_form_builder(frm) {
	let builder = frappe.web_form_builder;
	if (!builder?.store || builder.frm !== frm || !builder.store.dirty) return;

	let fields = builder.store.update_fields();
	if (typeof fields === "string") frappe.throw(fields);
}

function repoint_form_builder(builder, frm, wrapper) {
	Object.assign(builder, builder_options(frm), {
		$wrapper: wrapper,
		frm,
		page: frm.page,
		docname: frm.doc.name,
	});
	builder.init(true);
	builder.store.fetch();
}

function sync_form_builder(builder, frm) {
	builder.force_read_only = is_read_only(frm);
	if (builder.docname === frm.doc.name && builder.doctype === frm.doc.doc_type) return;

	builder.docname = frm.doc.name;
	builder.doctype = frm.doc.doc_type;
	builder.update_store();
	builder.setup_page_actions();
	builder.store.fetch();
}

function on_controlled_access_change(frm) {
	const has_controlled_access = frm.doc.login_required || frm.doc.key_required;
	if (!has_controlled_access) {
		frm.set_value("allow_multiple", 0);
		frm.set_value("allow_edit", 0);
		frm.set_value("allow_delete", 0);
		frm.set_value("show_list", 0);
	}
	render_list_settings_message(frm);
}

function render_list_settings_message(frm) {
	if (
		frm.fields_dict["list_setting_message"] &&
		!frm.doc.login_required &&
		!frm.doc.key_required
	) {
		const go_to_access_fields = `
			<code class="pointer" title="${__("Go to Access Control section")}">
				${__("Login Required")}
			</code>
			${__("or")}
			<code class="pointer" title="${__("Go to Access Control section")}">
				${__("Key Required")}
			</code>
		`;
		let message = __(
			"Login or a request key is required to see web form list view. Enable {0} to see list settings",
			[go_to_access_fields]
		);
		$(frm.fields_dict["list_setting_message"].wrapper)
			.html($(`<div class="form-message blue">${message}</div>`))
			.find("code")
			.click(() => frm.scroll_to_field("access_control_section"));
	} else {
		$(frm.fields_dict["list_setting_message"].wrapper).empty();
	}
}
