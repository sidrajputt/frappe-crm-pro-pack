"""TEMPORARY diagnostics: find out what freezes or crashes the app.

What it does
------------
* Writes one line per event to ``<bench>/logs/crm_addons_debug.log`` and to the console you started the bench
  in (``bench start``), so you can watch it live or send the file.
* Logs every request to this app (and to CRM's dashboard and page) with how long it took, and every background
  job (campaign dispatch, send batches, audience building, status sync) with its start, end and duration.
* A watchdog thread notices work that is taking too long and writes the **stack trace of the stuck code** after
  10 s, 30 s, 2 min and 10 min, plus the process memory every 30 s while something runs. This is what shows
  *where* a hang is, even when the process never finishes.
* The browser side (``public/debug.js``) reports freezes, slow calls and errors into the same file through
  ``client_log`` below.

It never raises: every function here swallows its own errors, so it cannot be the cause of a problem.

Switching it off / removing it
------------------------------
* Off:  ``bench --site <site> set-config crm_addons_debug_log 0``  (or set the environment variable
  ``CRM_ADDONS_DEBUG=0``). No console copy: ``set-config crm_addons_debug_console 0``.
* Removal: see docs/DEBUGGING.md (delete this file, ``public/debug.js`` and the few lines that mention it).
"""

import functools
import inspect
import json
import logging
import os
import sys
import tempfile
import threading
import time
import traceback
from contextlib import contextmanager

import frappe

LOG_FILE = "crm_addons_debug.log"
MAX_BYTES = 20 * 1024 * 1024  # the file is started afresh (the old one kept as .1) when it grows past this
STALL_STEPS = (10, 30, 120, 600)  # seconds after which a stack trace of the running work is written
INTERESTING = ("/api/method/crm_addons.", "/api/method/crm.api.dashboard", "/crm")

_logger = None
_logger_lock = threading.Lock()


# -- switches -----------------------------------------------------------------------------------------------


def _conf(key, default):
	try:
		return frappe.conf.get(key, default)
	except Exception:
		return default


def _off(value):
	return str(value).strip().lower() in ("0", "false", "off", "none", "no", "")


def enabled():
	if _off(os.environ.get("CRM_ADDONS_DEBUG", "1")):
		return False
	try:  # a test run must not fill the log you read to find a real freeze (the diagnostics' own tests switch it on)
		if frappe.flags.in_test and not frappe.flags.get("crm_addons_debug_in_test"):
			return False
	except Exception:
		pass
	return not _off(_conf("crm_addons_debug_log", 1))


# -- writing ---------------------------------------------------------------------------------------------------


def log_path():
	try:
		base = os.path.join(frappe.utils.get_bench_path(), "logs")
	except Exception:
		base = tempfile.gettempdir()
	try:
		os.makedirs(base, exist_ok=True)
		if not os.access(base, os.W_OK):
			raise OSError(base)
	except OSError:
		base = tempfile.gettempdir()
	return os.path.join(base, LOG_FILE)


def _get_logger():
	global _logger
	if _logger is not None:
		return _logger
	with _logger_lock:
		if _logger is not None:
			return _logger
		logger = logging.getLogger("crm_addons_debug")
		logger.setLevel(logging.INFO)
		logger.propagate = False
		path = log_path()
		try:
			if os.path.exists(path) and os.path.getsize(path) > MAX_BYTES:
				os.replace(path, path + ".1")
		except OSError:
			pass
		formatter = logging.Formatter("%(asctime)s.%(msecs)03d %(message)s", "%Y-%m-%d %H:%M:%S")
		if not logger.handlers:
			file_handler = logging.FileHandler(path, encoding="utf-8")  # append; every process writes whole lines
			file_handler.setFormatter(formatter)
			logger.addHandler(file_handler)
			if not _off(_conf("crm_addons_debug_console", 1)):
				console = logging.StreamHandler(sys.stderr)
				console.setFormatter(logging.Formatter("[crm_addons] %(asctime)s.%(msecs)03d %(message)s", "%H:%M:%S"))
				logger.addHandler(console)
		_logger = logger
		return logger


def _short(value, limit=300):
	text = str(value).replace("\r", " ").replace("\n", " ")
	return text if len(text) <= limit else text[:limit] + "..."


def _context():
	site = user = ""
	try:
		site = getattr(frappe.local, "site", "") or ""
		user = frappe.session.user if getattr(frappe.local, "session", None) else ""
	except Exception:
		pass
	return site, user


def log(event, level="INFO", **fields):
	"""One line: time, level, process, thread, site, user, the event, then key=value pairs."""
	try:
		if not enabled():
			return
		site, user = _context()
		parts = [f"{level:5}", f"pid={os.getpid()}", threading.current_thread().name, site, user or "-", event]
		parts += [f"{k}={_short(v)}" for k, v in fields.items() if v not in (None, "")]
		_get_logger().info(" ".join(p for p in parts if p))
	except Exception:
		pass


def log_block(event, text, level="INFO", **fields):
	"""An event followed by an indented block (a stack trace, a list of crumbs)."""
	try:
		if not enabled():
			return
		log(event, level, **fields)
		_get_logger().info("\n".join("        " + line for line in str(text).rstrip().splitlines()))
	except Exception:
		pass


def rss_mb():
	"""Peak memory of this process in MB (it only grows: a steady climb is what to look for)."""
	try:
		import resource

		peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
		return round(peak / (1024 * 1024 if sys.platform == "darwin" else 1024), 1)  # bytes on macOS, KB on Linux
	except Exception:
		return None


# -- the watchdog: stack traces of work that is taking too long -----------------------------------------------

_ACTIVE = {}  # key -> {name, started, thread_id, steps}
_ACTIVE_LOCK = threading.Lock()
_monitor = {"pid": None, "thread": None}
_counter = [0]


def _monitor_loop():
	last_memory = 0.0
	while True:
		time.sleep(2)
		try:
			now = time.monotonic()
			with _ACTIVE_LOCK:
				items = list(_ACTIVE.values())
			for entry in items:
				elapsed = now - entry["started"]
				for step in STALL_STEPS:
					if elapsed >= step and step not in entry["steps"]:
						entry["steps"].add(step)
						frame = sys._current_frames().get(entry["thread_id"])
						stack = "".join(traceback.format_stack(frame)) if frame else "(the thread has already finished)"
						log_block(f"STALLED {entry['name']} still running after {elapsed:.0f}s - where it is stuck:", stack, "WARN")
			if items and now - last_memory >= 30:
				last_memory = now
				log("MEMORY", rss_peak_mb=rss_mb(), running=len(items), threads=threading.active_count())
		except Exception:
			pass


def _ensure_monitor():
	pid = os.getpid()
	thread = _monitor["thread"]
	if _monitor["pid"] == pid and thread is not None and thread.is_alive():
		return
	_monitor["pid"] = pid  # a forked worker has no thread of its own: start one
	_monitor["thread"] = threading.Thread(target=_monitor_loop, name="crm-addons-debug-watchdog", daemon=True)
	_monitor["thread"].start()


def register(name):
	_ensure_monitor()
	with _ACTIVE_LOCK:
		_counter[0] += 1
		key = _counter[0]
		_ACTIVE[key] = {"name": name, "started": time.monotonic(), "thread_id": threading.get_ident(), "steps": set()}
	return key


def unregister(key):
	with _ACTIVE_LOCK:
		_ACTIVE.pop(key, None)


@contextmanager
def watch(name, **info):
	"""Log the start, the end (with its duration) and any stall of a block of work. Failures are logged with the
	traceback and then raised again unchanged."""
	if not enabled():
		yield
		return
	key = register(name)
	started = time.monotonic()
	log(f"START {name}", **info)
	status = "ok"
	try:
		yield
	except BaseException as exc:
		status = f"{type(exc).__name__}: {_short(exc, 200)}"
		log_block(f"FAILED {name} after {time.monotonic() - started:.2f}s: {status}", traceback.format_exc(), "ERROR")
		raise
	finally:
		unregister(key)
		took = time.monotonic() - started
		log(f"END   {name}", "WARN" if took > 30 else "INFO", took=f"{took:.2f}s", status=status, rss_peak_mb=rss_mb())


def traced(name=None):
	"""Decorator: ``watch`` a whole function (used on the campaign jobs)."""

	def wrap(fn):
		label = name or f"{fn.__module__.rsplit('.', 1)[-1]}.{fn.__name__}"

		@functools.wraps(fn)
		def inner(*args, **kwargs):
			if not enabled():
				return fn(*args, **kwargs)
			try:  # name the arguments as the function does; lists are shown as their length
				bound = inspect.signature(fn).bind_partial(*args, **kwargs).arguments
			except TypeError:
				bound = dict(kwargs)
			info = {k: (len(v) if isinstance(v, (list, tuple, set, dict)) else v) for k, v in bound.items()}
			with watch(label, **info):
				return fn(*args, **kwargs)

		return inner

	return wrap


# -- every request to this app ----------------------------------------------------------------------------------

_ARG_KEYS = {"name", "status", "channel", "start", "page_length", "from_date", "to_date", "scope", "user", "with_summary", "cmd"}


def _arguments():
	try:
		out = []
		for key, value in (frappe.local.form_dict or {}).items():
			if key in _ARG_KEYS:
				out.append(f"{key}={_short(value, 60)}")
			else:
				out.append(f"{key}:{len(str(value))}b")
		return " ".join(out[:14])
	except Exception:
		return ""


def before_request(*args, **kwargs):
	"""``before_request`` hook."""
	try:
		if not enabled():
			return
		request = frappe.local.request
		path = request.path or ""
		if not path.startswith(INTERESTING):
			return
		frappe.local.crm_addons_debug = {
			"key": register(f"{request.method} {path}"),
			"started": time.monotonic(),
		}
	except Exception:
		pass


def after_request(response=None, request=None, **kwargs):
	"""``after_request`` hook."""
	try:
		info = getattr(frappe.local, "crm_addons_debug", None)
		if not info:
			return
		unregister(info["key"])
		took = time.monotonic() - info["started"]
		log(
			f"{request.method} {request.path}",
			"WARN" if took > 3 else "INFO",
			status=getattr(response, "status_code", "?"),
			took=f"{took:.2f}s",
			size=getattr(response, "content_length", ""),
			args=_arguments() if request.path.startswith("/api/") else "",
		)
	except Exception:
		pass


# -- what the browser reports --------------------------------------------------------------------------------------


@frappe.whitelist()
def client_log(entries=None, page=None, session=None):
	"""The browser's own report (``public/debug.js``): freezes, slow calls, errors and what was happening just before."""
	try:
		if frappe.session.user == "Guest" or not enabled():
			return {"enabled": False}
		if isinstance(entries, str):
			entries = json.loads(entries)
		for entry in list(entries or [])[:100]:
			if not isinstance(entry, dict):
				entry = {"m": entry}
			level = entry.get("l") if entry.get("l") in ("INFO", "WARN", "ERROR") else "INFO"
			head = f"CLIENT page={_short(page, 60)} session={_short(session, 12)} {_short(entry.get('m'), 1500)}"
			if entry.get("x"):
				log_block(head, entry["x"], level)
			else:
				log(head, level)
		return {"enabled": True, "log": log_path()}
	except Exception:
		return {"enabled": True}


@frappe.whitelist()
def tail(lines=300):
	"""The end of the debug log, for a System Manager (so it can be read or copied from the browser console)."""
	frappe.only_for("System Manager")
	path = log_path()
	try:
		with open(path, encoding="utf-8", errors="replace") as handle:
			content = handle.readlines()[-min(int(lines), 5000):]
	except OSError:
		content = []
	return {"path": path, "enabled": enabled(), "lines": "".join(content)}
