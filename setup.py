from setuptools import find_packages, setup

with open("requirements.txt", encoding="utf-8") as f:
	install_requires = [line.strip() for line in f if line.strip() and not line.startswith("#")]

with open("README.md", encoding="utf-8") as f:
	long_description = f.read()

setup(
	name="crm_addons",
	version="1.0.0",
	description=(
		"CRM Pro Pack for Frappe CRM: Google Meet meetings, call follow-ups, lead scoring, "
		"a role-aware Sales Dashboard with Excel export, and reminders."
	),
	long_description=long_description,
	long_description_content_type="text/markdown",
	author="Siddharth Singh",
	url="https://github.com/sidrajputt/frappe-crm-pro-pack",
	license="MIT",
	keywords="frappe crm google-meet google-calendar follow-up lead-scoring sales-dashboard erpnext",
	python_requires=">=3.10",
	classifiers=[
		"Framework :: Frappe",
		"License :: OSI Approved :: MIT License",
		"Programming Language :: Python :: 3",
	],
	packages=find_packages(),
	zip_safe=False,
	include_package_data=True,
	install_requires=install_requires,
)
