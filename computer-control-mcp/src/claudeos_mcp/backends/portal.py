"""xdg-desktop-portal Screenshot call (org.freedesktop.portal.Screenshot.Screenshot).

The portal answers asynchronously with a ``Response`` signal on a per-request object, sent as a
*unicast* to the calling connection. A separate ``gdbus call`` process therefore can never see
the answer (its connection is gone, and ``gdbus monitor`` on another connection does not receive
unicast signals), so this is done in-process with ``jeepney`` (pure-Python D-Bus), keeping the
call and the signal on one connection.
"""

from __future__ import annotations

import secrets
from urllib.parse import unquote, urlparse


class PortalError(RuntimeError):
    pass


def portal_screenshot(timeout: float = 30.0) -> str:
    """Take a non-interactive screenshot through the portal; return the saved file's path."""
    try:
        from jeepney import DBusAddress, MatchRule, message_bus, new_method_call
        from jeepney.io.blocking import Proxy, open_dbus_connection
    except ImportError as exc:  # pragma: no cover - jeepney is a declared dependency
        raise PortalError("python package 'jeepney' is not installed") from exc

    portal = DBusAddress(
        "/org/freedesktop/portal/desktop",
        bus_name="org.freedesktop.portal.Desktop",
        interface="org.freedesktop.portal.Screenshot",
    )
    try:
        conn = open_dbus_connection(bus="SESSION")
    except Exception as exc:  # noqa: BLE001 - any connection failure means "no portal"
        raise PortalError(f"cannot connect to the session bus: {exc}") from exc
    with conn:
        token = "claudeos" + secrets.token_hex(6)
        sender = conn.unique_name.lstrip(":").replace(".", "_")
        handle = f"/org/freedesktop/portal/desktop/request/{sender}/{token}"
        rule = MatchRule(type="signal", interface="org.freedesktop.portal.Request", member="Response", path=handle)
        Proxy(message_bus, conn).AddMatch(rule)
        with conn.filter(rule) as responses:
            call = new_method_call(
                portal,
                "Screenshot",
                "sa{sv}",
                ("", {"handle_token": ("s", token), "interactive": ("b", False)}),
            )
            reply = conn.send_and_get_reply(call, timeout=timeout)
            if reply.header.message_type.name == "error":
                raise PortalError(f"portal refused the call: {reply.body}")
            try:
                signal = conn.recv_until_filtered(responses, timeout=timeout)
            except TimeoutError as exc:
                raise PortalError("portal did not answer (permission dialog pending?)") from exc
    code, results = signal.body
    if code != 0:
        raise PortalError("screenshot permission denied in the portal" if code == 1 else f"portal error {code}")
    uri = results.get("uri", ("s", ""))[1]
    return uri_to_path(uri)


def uri_to_path(uri: str) -> str:
    """``file:///home/u/Pictures/Screenshot%201.png`` → ``/home/u/Pictures/Screenshot 1.png``."""
    parsed = urlparse(uri)
    if parsed.scheme != "file" or not parsed.path:
        raise PortalError(f"portal returned an unexpected URI: {uri!r}")
    return unquote(parsed.path)
