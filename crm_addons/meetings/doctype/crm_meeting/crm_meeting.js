// Copyright (c) 2026, Coding Pro
// Desk form for CRM Meeting (the CRM itself uses the meetings calendar page).
frappe.ui.form.on("CRM Meeting", {
	refresh(frm) {
		if (frm.doc.google_meet_link) {
			frm.add_custom_button(__("Join meeting"), () => window.open(frm.doc.google_meet_link, "_blank"));
		}
		if (!frm.is_new()) {
			frm.add_custom_button(__("Refresh guest responses"), () =>
				frappe.call({
					method: "crm_addons.api.refresh_meeting",
					args: { name: frm.doc.name },
					callback: () => frm.reload_doc(),
				})
			);
		}
	},
});
