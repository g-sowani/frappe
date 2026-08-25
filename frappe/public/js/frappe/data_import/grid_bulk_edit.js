frappe.provide("frappe.data_import");

import { get_columns_for_picker, is_insert_import_type } from "./data_exporter";
import { render_preview_datatable } from "./import_preview";

const GRID_BULK_EDIT_PATH = "frappe.core.doctype.data_import.grid_bulk_edit";
const DONT_IMPORT = "Don't Import";
// keep in step with FEW_RECORD_COUNT in grid_bulk_edit.py
const FEW_RECORD_COUNT = 5;

// Bulk-edit ("Bulk Edit" button) flow for a child table shown as a Grid on a
// form (e.g. Website Settings -> Route Redirects, Customize Form -> Fields).
// Deliberately shaped like the real Data Import tool -- same Import Type
// options, same "Download Template" / "Import File" step, same Export Type
// choices and column picker as `DataExporter`, same column-mapping and
// warnings pass before anything is applied -- but scoped to a single child
// doctype and, unlike Data Import, the row data (which may include unsaved
// edits) always comes from the browser instead of the database.
//
// The whole flow lives in a *single* `frappe.ui.Dialog`, held at a constant
// size so nothing re-opens or jumps between steps; overflow scrolls.
// `GridBulkEditDialog` owns that dialog and hands it, one screen at a time,
// to the small renderer classes below -- each renders its own body content
// and claims the dialog's title and footer buttons while it is showing.
frappe.data_import.GridBulkEditDialog = class GridBulkEditDialog {
	constructor({
		doctype,
		fieldname,
		child_doctype,
		docname,
		title,
		get_rows,
		on_update,
		editable = true,
	}) {
		this.doctype = doctype;
		this.fieldname = fieldname;
		this.docname = docname;
		this.child_doctype = child_doctype;
		this.title = title || frappe.model.unscrub(fieldname);
		this.get_rows = get_rows;
		this.on_update = on_update;
		this.editable = editable;

		this.make_dialog();
		this.show_import_type_screen();
	}

	make_dialog() {
		this.dialog = new frappe.ui.Dialog({
			// standard width on purpose: the widest screen here is the column
			// picker, which is a two-column checkbox grid rather than a form,
			// so it does not need the roomier "large" modal
			title: __("Bulk Edit {0}", [this.title]),
			fields: [],
		});
		this.dialog.show();
	}

	// Each screen starts from an empty body and re-declares the dialog's
	// title and buttons, so nothing from the previous screen leaks into it.
	set_screen(Screen, props) {
		this.dialog.$body.empty();
		const $container = $('<div class="grid-bulk-edit-screen">').appendTo(this.dialog.$body);
		this.screen = new Screen({ dialog: this.dialog, $container, ...props });
	}

	show_import_type_screen() {
		this.dialog.set_title(__("Bulk Edit {0}", [this.title]));
		this.set_screen(ImportTypeScreen, {
			import_type: this.import_type,
			on_next: (import_type) => {
				this.import_type = import_type;
				this.show_choose_action_screen();
			},
		});
	}

	show_choose_action_screen() {
		this.dialog.set_title(__("Bulk Edit {0}", [this.title]));
		this.set_screen(ChooseActionScreen, {
			import_type: this.import_type,
			editable: this.editable,
			on_back: () => this.show_import_type_screen(),
			on_download: () => this.show_export_screen(),
			on_file: (file) => this.show_preview_screen(file),
		});
	}

	show_export_screen() {
		this.dialog.set_title(__("Download Template: {0}", [this.title]));
		this.set_screen(ExportScreen, {
			doctype: this.doctype,
			fieldname: this.fieldname,
			docname: this.docname,
			child_doctype: this.child_doctype,
			import_type: this.import_type,
			get_rows: this.get_rows,
			on_back: () => this.show_choose_action_screen(),
			on_downloaded: () => this.show_choose_action_screen(),
		});
	}

	show_preview_screen(file) {
		const import_type = this.import_type;
		const existing_names = (this.get_rows() || []).map((row) => row.name).filter(Boolean);
		const fetch_preview = (column_to_field_map) =>
			frappe.data_import.fetch_grid_bulk_edit_preview({
				doctype: this.doctype,
				fieldname: this.fieldname,
				docname: this.docname,
				file,
				import_type,
				existing_names,
				column_to_field_map,
			});

		this.dialog.set_title(__("Preview: {0}", [this.title]));
		this.set_screen(PreviewScreen, { loading: true });
		fetch_preview().then((preview) => {
			this.set_screen(PreviewScreen, {
				child_doctype: this.child_doctype,
				import_type,
				preview,
				fetch_preview,
				on_back: () => this.show_choose_action_screen(),
				on_confirm: (rows) => {
					this.on_update(rows, import_type);
					this.dialog.hide();
				},
			});
		});
	}
};

/** `Data Import`'s own `import_type` field is the single source of truth for
 * the three options ("Insert New Records" / "Update Existing Records" /
 * "Insert or Update Records"), so this reads them off that doctype's meta
 * rather than keeping a second copy that could drift. */
function get_import_type_options() {
	return new Promise((resolve) => {
		frappe.model.with_doctype("Data Import", () => {
			const df = frappe.meta.get_docfield("Data Import", "import_type");
			resolve((df.options || "").split("\n").filter(Boolean));
		});
	});
}

/** A control built on its own (rather than through a Dialog's declarative
 * `fields:` array) has no bound doc, so the `df.default` that Layout would
 * normally apply is never picked up -- only `df.initial_value` is, in
 * `ControlInput.make`. Bridge the two so callers can keep writing `default`. */
function make_control(df, $parent) {
	if (df.default != null && df.initial_value == null) {
		df = { ...df, initial_value: df.default };
	}
	return frappe.ui.form.make_control({ parent: $parent.get(0), df, render_input: true });
}

/** Screen 1: pick an Import Type. */
class ImportTypeScreen {
	constructor({ dialog, $container, import_type, on_next }) {
		this.dialog = dialog;
		this.$container = $container;
		this.on_next = on_next;

		this.dialog.get_primary_btn().removeClass("hide");
		this.dialog.get_secondary_btn().addClass("hide");
		this.render(import_type);
	}

	render(import_type) {
		get_import_type_options().then((options) => {
			this.import_type_control = make_control(
				{
					fieldtype: "Select",
					fieldname: "import_type",
					label: __("Import Type"),
					options,
					default: import_type || options[0],
					reqd: 1,
				},
				this.$container
			);
			this.dialog.set_primary_action(__("Next"), () =>
				this.on_next(this.import_type_control.get_value())
			);
		});
	}
}

/** Screen 2: the chosen Import Type (now fixed, shown read-only) plus the two
 * ways forward -- exactly the Data Import form's own "Download Template" and
 * "Import File" pairing. The uploader is mounted inline here rather than
 * opened as its own modal, so the whole wizard stays in one dialog. */
class ChooseActionScreen {
	constructor({ dialog, $container, import_type, editable, on_back, on_download, on_file }) {
		this.dialog = dialog;
		this.$container = $container;
		this.editable = editable;

		this.dialog.get_primary_btn().removeClass("hide");
		this.dialog.set_secondary_action_label(__("Back"));
		this.dialog.set_secondary_action(on_back);

		$container.html(`
			<div class="import-type-control"></div>
			<div class="margin-bottom">
				<button class="btn btn-default btn-sm" data-action="download">
					${__("Download Template")}
				</button>
			</div>
			<label class="control-label">${__("Import File")}</label>
			<div class="grid-bulk-edit-uploader"></div>
		`);
		frappe.utils.bind_actions_with_object($container, { download: on_download });

		make_control(
			{
				fieldtype: "Data",
				fieldname: "import_type",
				label: __("Import Type"),
				default: import_type,
				read_only: 1,
			},
			$container.find(".import-type-control")
		);

		this.make_uploader(on_file);
	}

	make_uploader(on_file) {
		if (!this.editable) {
			this.$container
				.find(".grid-bulk-edit-uploader")
				.html(`<div class="text-muted">${__("This table cannot be edited")}</div>`);
			this.dialog.get_primary_btn().addClass("hide");
			return;
		}

		this.file_uploader = new frappe.ui.FileUploader({
			wrapper: this.$container.find(".grid-bulk-edit-uploader"),
			as_dataurl: true,
			allow_multiple: false,
			restrictions: {
				allowed_file_types: [".csv", ".xlsx"],
			},
			on_success: (file) => on_file(file),
		});

		this.dialog.set_primary_action(__("Upload"), () => {
			if (!this.file_uploader.uploader.files.length) {
				frappe.msgprint(__("Please select a file first."));
				return;
			}
			this.file_uploader.upload_files();
		});
	}
}

/** Screen 3: "Download Template" -- the same choices `DataExporter` offers for
 * a real Data Import (File Type, Export Type + filters, and the searchable
 * "select fields" checkbox grid), differing only in where the rows come from:
 * whatever the grid currently holds, unsaved edits included, rather than a
 * database query. The Export Type selection itself is resolved server-side by
 * `select_export_rows`, which also backs the record-count hint, so the count
 * and the downloaded file can never disagree. */
class ExportScreen {
	constructor({
		dialog,
		$container,
		doctype,
		fieldname,
		docname,
		child_doctype,
		import_type,
		get_rows,
		on_back,
		on_downloaded,
	}) {
		this.dialog = dialog;
		this.$container = $container;
		this.doctype = doctype;
		this.fieldname = fieldname;
		this.docname = docname;
		this.child_doctype = child_doctype;
		this.import_type = import_type;
		this.get_rows = get_rows;
		this.on_downloaded = on_downloaded;

		this.dialog.get_primary_btn().removeClass("hide");
		this.dialog.set_secondary_action_label(__("Back"));
		this.dialog.set_secondary_action(on_back);
		this.dialog.set_primary_action(__("Download"), () => this.export_rows());

		this.render();
	}

	render() {
		this.$container.html(`
			<div class="file-type-control"></div>
			<div class="export-type-control"></div>
			<div class="filter-area hide margin-bottom"></div>
			<div class="select-all-buttons margin-top"></div>
			<div class="columns-control"></div>
		`);

		this.file_type_control = make_control(
			{
				fieldtype: "Select",
				fieldname: "file_type",
				label: __("File Type"),
				options: ["Excel", "CSV"],
				default: "Excel",
			},
			this.$container.find(".file-type-control")
		);

		this.export_records_control = make_control(
			{
				fieldtype: "Select",
				fieldname: "export_records",
				label: __("Export Type"),
				options: [
					{ label: __("All Records"), value: "all" },
					{ label: __("Filtered Records"), value: "by_filter" },
					{ label: __("{0} Records", [FEW_RECORD_COUNT]), value: "5_records" },
					{ label: __("Blank Template"), value: "blank_template" },
				],
				// same rule as DataExporter: a pure insert starts from a blank
				// template, anything that can update starts from the real rows
				default: is_insert_import_type(this.import_type) ? "blank_template" : "all",
				change: () => this.on_export_records_change(),
			},
			this.$container.find(".export-type-control")
		);

		this.columns_control = make_control(
			{
				label: __(this.child_doctype),
				fieldname: "columns",
				fieldtype: "MultiCheck",
				columns: 2,
				sort_options: false,
				on_change: () => this.update_primary_action(),
				options: this.get_column_options(),
			},
			this.$container.find(".columns-control")
		);

		this.make_filter_area();
		this.make_select_all_buttons();
		this.setup_search_input();
		frappe.utils.setup_search(this.$container, ".unit-checkbox", ".label-area");
		this.select_mandatory();
		this.update_record_count_message();
	}

	// `name` (the "ID" column) is only worth offering once a row could already
	// exist to match against -- never for a pure insert.
	get_column_options() {
		const fields = get_columns_for_picker(this.child_doctype)[this.child_doctype] || [];
		const offer_id_column = !is_insert_import_type(this.import_type);
		return fields
			.filter((df) => df.fieldname !== "name" || offer_id_column)
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

	make_filter_area() {
		this.filter_group = new frappe.ui.FilterGroup({
			parent: this.$container.find(".filter-area"),
			doctype: this.child_doctype,
			// A child doctype holds no permissions of its own, so FieldSelect
			// would perm-check it and offer no fields at all ("... is not
			// selectable"); naming the parent makes it check that instead.
			parent_doctype: this.doctype,
			on_change: () => this.update_record_count_message(),
		});
	}

	get_filters() {
		return (this.filter_group?.get_filters() || []).map((filter) => filter.slice(0, 4));
	}

	on_export_records_change() {
		const by_filter = this.export_records_control.get_value() === "by_filter";
		this.$container.find(".filter-area").toggleClass("hide", !by_filter);
		this.update_record_count_message();
	}

	/** Row count for the current Export Type. The three cheap cases are
	 * answered here; filtering is left to the server so that it stays the one
	 * implementation `download_template` also uses. */
	get_row_count() {
		const rows = this.get_rows() || [];
		const export_records = this.export_records_control.get_value();

		if (export_records === "blank_template") return Promise.resolve(0);
		if (export_records === "5_records")
			return Promise.resolve(Math.min(FEW_RECORD_COUNT, rows.length));
		if (export_records !== "by_filter") return Promise.resolve(rows.length);

		return frappe.xcall(`${GRID_BULK_EDIT_PATH}.get_export_row_count`, {
			doctype: this.doctype,
			fieldname: this.fieldname,
			docname: this.docname,
			rows,
			export_records,
			export_filters: this.get_filters(),
		});
	}

	update_record_count_message() {
		this.get_row_count().then((count) => {
			this.row_count = count;
			let message;
			if (count === 0) {
				message = __("No records will be exported");
			} else if (count === 1) {
				message = __("1 record will be exported");
			} else {
				message = __("{0} records will be exported", [count]);
			}
			this.export_records_control.set_description(message);
			this.update_primary_action();
		});
	}

	update_primary_action() {
		const columns = this.columns_control.get_value() || [];
		const count = this.row_count;
		let label;
		// same phrasing as DataExporter's "Export"/"Export N records": with
		// nothing to export the count adds nothing, so drop it
		if (!count) {
			label = __("Download");
		} else if (count === 1) {
			label = __("Download 1 record");
		} else {
			label = __("Download {0} records", [count]);
		}

		const $btn = this.dialog.get_primary_btn();
		this.dialog.set_btn_label($btn, label);
		$btn.prop("disabled", columns.length === 0);
	}

	make_select_all_buttons() {
		let $select_all_buttons = $(`
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
		`);
		frappe.utils.bind_actions_with_object($select_all_buttons, this);
		this.$container.find(".select-all-buttons").html($select_all_buttons);
	}

	select_all() {
		this.$container.find(".columns-control :checkbox").prop("checked", true).trigger("change");
	}

	select_mandatory() {
		let checkboxes = (this.columns_control.options || [])
			.filter((option) => option.danger)
			.map((option) => option.$checkbox.find("input").get(0));

		this.unselect_all();
		$(checkboxes).prop("checked", true).trigger("change");
	}

	unselect_all() {
		this.$container
			.find(".columns-control :checkbox")
			.prop("checked", false)
			.trigger("change");
	}

	setup_search_input() {
		this.$container.find(".select-all-buttons").before(`
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

	export_rows() {
		open_url_post(`/api/method/${GRID_BULK_EDIT_PATH}.download_template`, {
			doctype: this.doctype,
			fieldname: this.fieldname,
			docname: this.docname,
			columns: this.columns_control.get_value(),
			rows: this.get_rows(),
			file_type: this.file_type_control.get_value(),
			import_type: this.import_type,
			export_records: this.export_records_control.get_value(),
			export_filters: this.get_filters(),
		});
		this.on_downloaded();
	}
}

/** Screen 4: what the uploaded file parsed into -- a green/red indicator per
 * column for whether it matched a real field, the rows themselves, any
 * row/column warnings, and a "Map Columns" pass for headers that didn't
 * match. Nothing reaches the Grid until "Start Upload". */
class PreviewScreen {
	constructor({
		dialog,
		$container,
		child_doctype,
		import_type,
		loading,
		preview,
		fetch_preview,
		on_back,
		on_confirm,
	}) {
		this.dialog = dialog;
		this.$container = $container;
		this.child_doctype = child_doctype;
		this.import_type = import_type;
		this.fetch_preview = fetch_preview;
		this.on_confirm = on_confirm;

		if (loading) {
			this.dialog.get_primary_btn().addClass("hide");
			this.dialog.get_secondary_btn().addClass("hide");
			$container.html(
				`<div class="text-muted text-center margin-top margin-bottom">${__(
					"Loading preview..."
				)}</div>`
			);
			return;
		}

		this.dialog.get_secondary_btn().removeClass("hide");
		this.dialog.set_secondary_action_label(__("Back"));
		this.dialog.set_secondary_action(on_back);
		this.dialog.get_primary_btn().removeClass("hide");
		this.dialog.set_primary_action(__("Start Upload"), () =>
			this.on_confirm(this.preview.rows)
		);

		// same markup (and therefore the same stylesheet) as the Data Import
		// tool's own preview: actions above the table, row count below it
		$container.html(`
			<div class="preview-summary"></div>
			<div class="table-preview"></div>
			<div class="table-message"></div>
			<div class="preview-warnings"></div>
		`);
		this.set_preview(preview);
	}

	set_preview(preview) {
		this.preview = preview;
		this.render_summary();
		this.render_table();
		this.render_table_message();
		this.render_warnings();
	}

	render_summary() {
		const warning_count = this.preview.warnings.length;
		const $wrapper = $(`
			<div class="table-actions flex justify-between align-center margin-bottom">
				<button class="btn btn-default btn-xs" data-action="show_column_mapper">
					${__("Map Columns")}
				</button>
				${
					warning_count
						? `<span class="indicator orange">${__("{0} warnings", [
								warning_count,
						  ])}</span>`
						: ""
				}
			</div>
		`);
		frappe.utils.bind_actions_with_object($wrapper, this);
		this.$container.find(".preview-summary").html($wrapper);
	}

	/** Columns in the shape DataTable wants: a Sr. No column (the row number
	 * the server already prefixed to every data row), then one per file column,
	 * green when it matched a field of this child doctype and red when it
	 * didn't -- the same signalling ImportPreview uses for skipped columns. */
	prepare_columns() {
		const row_number_label = __("Sr. No");
		const columns = [
			{
				id: "srno",
				name: row_number_label,
				content: row_number_label,
				editable: false,
				focusable: false,
				align: "left",
				width: 60,
			},
		];

		this.preview.columns.forEach((col) => {
			const matched = Boolean(col.fieldname);
			const title =
				frappe.utils.escape_html(col.header_title) || `<i>${__("Untitled Column")}</i>`;
			columns.push({
				id: col.fieldname || `column_${col.index}`,
				name: frappe.utils.escape_html(col.header_title) || row_number_label,
				content: `<span class="indicator ${matched ? "green" : "red"}">${title}</span>`,
				editable: false,
				focusable: false,
				align: "left",
				// unmatched columns are shown but greyed: they are in the file
				// and will simply be ignored
				width: matched ? 120 : 170,
				format: matched ? undefined : (value) => `<div class="text-muted">${value}</div>`,
			});
		});

		return columns;
	}

	render_table() {
		const data = this.preview.data.map((row) =>
			row.map((cell) => {
				if (cell == null) return "";
				return typeof cell === "string" ? frappe.utils.xss_sanitise(cell) : cell;
			})
		);

		if (this.datatable) {
			this.datatable.destroy();
			this.datatable = null;
		}
		this.datatable = render_preview_datatable(
			this.$container.find(".table-preview").get(0),
			data,
			this.prepare_columns()
		);
	}

	render_table_message() {
		const $message = this.$container.find(".table-message");
		const total = this.preview.total_number_of_rows || 0;
		if (!total) {
			$message.html(`<div class="text-muted margin-top text-medium">${__("No Data")}</div>`);
			return;
		}
		const text = total === 1 ? __("1 row") : __("Showing all {0} rows", [total]);
		$message.html(`<div class="text-muted margin-top text-medium">${text}</div>`);
	}

	render_warnings() {
		const $wrapper = this.$container.find(".preview-warnings");
		if (!this.preview.warnings.length) {
			$wrapper.html("");
			return;
		}

		const items = this.preview.warnings
			.map((warning) => {
				const prefix = warning.row ? __("Row {0}: ", [warning.row]) : "";
				const field_label = warning.field ? `${warning.field.label}: ` : "";
				return `<li>${prefix}${field_label}${warning.message}</li>`;
			})
			.join("");

		$wrapper.html(`
			<div class="warning">
				<h5 class="text-uppercase warning-row-header">${__("Warnings")}</h5>
				<div class="body"><ul>${items}</ul></div>
			</div>
		`);
	}

	show_column_mapper() {
		const field_options = [{ label: __(DONT_IMPORT), value: DONT_IMPORT }].concat(
			this.get_mappable_fields()
		);

		const fields = [];
		this.preview.columns.forEach((col, i) => {
			fields.push(
				{
					fieldtype: "Data",
					fieldname: `label_${i}`,
					label: "",
					default: col.header_title,
					read_only: 1,
				},
				{ fieldtype: "Column Break" },
				{
					fieldtype: "Select",
					fieldname: `field_${i}`,
					label: "",
					options: field_options,
					default: col.fieldname || DONT_IMPORT,
				},
				{ fieldtype: "Section Break" }
			);
		});

		let dialog = new frappe.ui.Dialog({
			title: __("Map Columns"),
			fields: [
				{
					fieldtype: "HTML",
					fieldname: "heading",
					options: `<div class="margin-top text-muted">${__(
						"Map columns from the uploaded file to fields in {0}",
						[__(this.child_doctype)]
					)}</div>`,
				},
				{ fieldtype: "Section Break" },
				...fields,
			],
			primary_action_label: __("Apply"),
			primary_action: (values) => {
				const column_to_field_map = {};
				this.preview.columns.forEach((col, i) => {
					column_to_field_map[i] = values[`field_${i}`];
				});
				dialog.hide();
				this.fetch_preview(column_to_field_map).then((preview) =>
					this.set_preview(preview)
				);
			},
		});
		dialog.$body.addClass("map-columns");
		dialog.show();
	}

	get_mappable_fields() {
		const offer_id_column = !is_insert_import_type(this.import_type);
		return (get_columns_for_picker(this.child_doctype)[this.child_doctype] || [])
			.filter((df) => df.fieldname !== "name" || offer_id_column)
			.map((df) => ({
				label: __(df.label || df.fieldname, null, df.parent),
				value: df.fieldname,
			}));
	}
}

frappe.data_import.fetch_grid_bulk_edit_preview = function ({
	doctype,
	fieldname,
	docname,
	file,
	import_type,
	existing_names,
	column_to_field_map,
}) {
	const file_type = /\.xlsx$/i.test(file.name || "") ? "Excel" : "CSV";
	return frappe.xcall(`${GRID_BULK_EDIT_PATH}.parse_uploaded_file`, {
		doctype,
		fieldname,
		docname,
		file_type,
		dataurl: file.dataurl,
		import_type,
		existing_names,
		column_to_field_map,
	});
};
