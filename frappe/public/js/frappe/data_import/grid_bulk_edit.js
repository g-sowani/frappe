frappe.provide("frappe.data_import");

import { get_columns_for_picker } from "./data_exporter";

const GRID_BULK_EDIT_PATH = "frappe.core.doctype.data_import.grid_bulk_edit";

// Bulk-edit ("Download" / "Upload") dialog for a child table shown as a Grid on a
// form (e.g. Website Settings -> Route Redirects, Customize Form -> Fields).
//
// Reuses the column picker (`get_columns_for_picker`) already built for
// `frappe.data_import.DataExporter`'s "Select Fields to Export" section, scoped
// down to a single child doctype, and posts to the CSV/Excel endpoints in
// `frappe.core.doctype.data_import.grid_bulk_edit` -- the same CSV/Excel
// machinery the Data Import tool itself is built on.
frappe.data_import.GridBulkEditDialog = class GridBulkEditDialog {
	constructor({ doctype, fieldname, child_doctype, docname, title, get_rows }) {
		this.doctype = doctype;
		this.fieldname = fieldname;
		this.docname = docname;
		this.title = title || frappe.model.unscrub(fieldname);
		this.get_rows = get_rows;
		this.child_doctype = child_doctype;

		this.make_dialog();
	}

	// Field layout intentionally mirrors `DataExporter`'s "Export Data" dialog
	// (File Type select, "SELECT FIELDS TO ..." heading, Select All / Select
	// Mandatory / Unselect All buttons, search box, doctype-labelled checkbox
	// grid) so the two "pick columns and download a template" flows in the
	// product look and behave the same. It deliberately leaves out
	// DataExporter's "Export Type" (All Records / Filtered / 5 Records / Blank
	// Template) -- that picks *which rows* a DB query exports, and this dialog
	// has no query: it always exports whatever rows are currently in the grid,
	// including unsaved edits.
	make_dialog() {
		this.dialog = new frappe.ui.Dialog({
			title: __("Bulk Edit {0}", [this.title]),
			fields: [
				{
					fieldtype: "Select",
					fieldname: "file_type",
					label: __("File Type"),
					options: ["Excel", "CSV"],
					default: "Excel",
				},
				{
					fieldtype: "Section Break",
				},
				{
					fieldtype: "HTML",
					fieldname: "select_all_buttons",
				},
				{
					label: __(this.child_doctype),
					fieldname: "columns",
					fieldtype: "MultiCheck",
					columns: 2,
					sort_options: false,
					on_change: () => this.update_primary_action(),
					options: this.get_column_options(),
				},
			],
			primary_action_label: __("Download"),
			primary_action: (values) => this.export_rows(values),
			on_page_show: () => this.setup_on_page_show(),
		});

		this.make_select_all_buttons();
		this.setup_search_input();
		this.dialog.show();
	}

	get_column_options() {
		const fields = get_columns_for_picker(this.child_doctype)[this.child_doctype] || [];
		return fields
			.filter((df) => df.fieldname !== "name")
			.map((df) => ({
				label: __(df.label || df.fieldname, null, df.parent),
				value: df.fieldname,
				danger: !!df.reqd,
				warning: !!df.depends_on,
				warning_title: df.depends_on ? __("Depends on: {0}", [df.depends_on]) : "",
				checked: false,
				description: `${df.fieldname} ${df.reqd ? __("(Mandatory)") : ""}`,
			}));
	}

	make_select_all_buttons() {
		let $select_all_buttons = $(`
			<div class="mb-3">
				<h6 class="form-section-heading uppercase">${__("Select Fields To Export")}</h6>
				<button class="btn btn-default btn-xs" data-action="select_all">
					${__("Select All")}
				</button>
				<button class="btn btn-default btn-xs" data-action="select_mandatory">
					${__("Select Mandatory")}
				</button>
				<button class="btn btn-default btn-xs" data-action="unselect_all">
					${__("Unselect All")}
				</button>
			</div>
		`);
		frappe.utils.bind_actions_with_object($select_all_buttons, this);
		this.dialog.get_field("select_all_buttons").$wrapper.html($select_all_buttons);
	}

	select_all() {
		this.dialog.$wrapper.find(":checkbox").prop("checked", true).trigger("change");
	}

	select_mandatory() {
		let checkboxes = (this.dialog.get_field("columns").options || [])
			.filter((option) => option.danger)
			.map((option) => option.$checkbox.find("input").get(0));

		this.unselect_all();
		$(checkboxes).prop("checked", true).trigger("change");
	}

	unselect_all() {
		this.dialog.$wrapper.find(":checkbox").prop("checked", false).trigger("change");
	}

	setup_search_input() {
		const $wrapper = this.dialog.get_field("select_all_buttons").$wrapper;
		if (this.dialog.$wrapper.find(".filters-search").length) return;

		$wrapper.before(`
			<div class="filters-search">
				<input
					type="text"
					placeholder="${__("Search")}"
					data-element="search"
					class="form-control input-xs"
				>
			</div>
		`);
	}

	setup_on_page_show() {
		frappe.utils.setup_search(this.dialog.$body, ".unit-checkbox", ".label-area");
		this.select_mandatory();
	}

	update_primary_action() {
		let columns = this.dialog.get_value("columns");
		this.dialog.get_primary_btn().prop("disabled", !columns || columns.length === 0);
	}

	export_rows(values) {
		open_url_post(`/api/method/${GRID_BULK_EDIT_PATH}.download_template`, {
			doctype: this.doctype,
			fieldname: this.fieldname,
			docname: this.docname,
			columns: this.dialog.get_value("columns"),
			rows: this.get_rows(),
			file_type: values.file_type,
		});
		this.dialog.hide();
	}
};

frappe.data_import.upload_grid_bulk_edit_file = function ({ doctype, fieldname, docname, file }) {
	const file_type = /\.xlsx$/i.test(file.name || "") ? "Excel" : "CSV";

	// resolves with the parsed rows (a list of field dicts), ready to drop into the Grid
	return frappe.xcall(`${GRID_BULK_EDIT_PATH}.parse_uploaded_file`, {
		doctype,
		fieldname,
		docname,
		file_type,
		dataurl: file.dataurl,
	});
};
