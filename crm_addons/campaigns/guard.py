"""Small safety helpers for the Campaign Manager. Standard library only (``requests`` is imported
when it is needed), so they can be tested without a Frappe site.

* ``ttl_cached``   - a short-lived, per-process cache for expensive read-only queries that the pages
                     ask for again and again (the audience scan, reply counts).
* ``http_timeout`` - gives every ``requests`` call made inside the block a time limit when it did not
                     set one. ``frappe_whatsapp`` calls Meta without any timeout, so a single stuck
                     request would otherwise hold a send worker until its 30-minute job limit.
"""

import threading
import time
from contextlib import contextmanager

# -- a short-lived cache ----------------------------------------------------------------------------------

_LOCK = threading.Lock()
_CACHE = {}  # key -> (expires_at, value)
_MAX_ENTRIES = 256


def ttl_cached(key, seconds, compute):
	"""``compute()`` once per ``seconds`` for the same ``key``. Only for read-only questions where a result a
	few seconds old is fine; never for anything a launch decides on."""
	now = time.monotonic()
	with _LOCK:
		hit = _CACHE.get(key)
		if hit and hit[0] > now:
			return hit[1]
	value = compute()
	with _LOCK:
		if len(_CACHE) >= _MAX_ENTRIES:
			for stale in [k for k, (expires, _v) in _CACHE.items() if expires <= now]:
				_CACHE.pop(stale, None)
			if len(_CACHE) >= _MAX_ENTRIES:  # still full of live entries: drop the oldest half
				for old in sorted(_CACHE, key=lambda k: _CACHE[k][0])[: _MAX_ENTRIES // 2]:
					_CACHE.pop(old, None)
		_CACHE[key] = (now + seconds, value)
	return value


def forget_cached(prefix=None):
	"""Drop cached results (all of them, or those whose key starts with ``prefix``)."""
	with _LOCK:
		for key in [k for k in _CACHE if prefix is None or (isinstance(k, tuple) and k and k[0] == prefix)]:
			_CACHE.pop(key, None)


# -- a time limit for HTTP calls that set none --------------------------------------------------------------

_HTTP_LOCK = threading.Lock()
_HTTP_USERS = 0
_HTTP_ORIGINAL = None


@contextmanager
def http_timeout(connect=10, read=30):
	"""Inside the block, a ``requests`` call that sets no timeout gets ``(connect, read)`` seconds.

	Calls that pass their own timeout are left alone. The change is installed once however many blocks are
	open at the same time (workers and web threads), and removed when the last one ends."""
	global _HTTP_USERS, _HTTP_ORIGINAL
	try:
		import requests
	except ImportError:  # nothing to guard
		yield
		return
	with _HTTP_LOCK:
		if _HTTP_USERS == 0:
			_HTTP_ORIGINAL = requests.sessions.Session.request
			original = _HTTP_ORIGINAL

			def limited(self, method, url, **kwargs):
				if kwargs.get("timeout") is None:
					kwargs["timeout"] = (connect, read)
				return original(self, method, url, **kwargs)

			requests.sessions.Session.request = limited
		_HTTP_USERS += 1
	try:
		yield
	finally:
		with _HTTP_LOCK:
			_HTTP_USERS -= 1
			if _HTTP_USERS == 0 and _HTTP_ORIGINAL is not None:
				requests.sessions.Session.request = _HTTP_ORIGINAL
				_HTTP_ORIGINAL = None
