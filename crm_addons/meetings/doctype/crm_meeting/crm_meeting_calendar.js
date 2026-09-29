// Desk calendar view: /app/crm-meeting/view/calendar
frappe.views.calendar["CRM Meeting"] = {
	field_map: {
		start: "starts_on",
		end: "ends_on",
		id: "name",
		title: "subject",
		status: "status",
	},
	get_css_class: (doc) => (doc.status === "Cancelled" ? "danger" : doc.status === "Completed" ? "success" : "primary"),
};
