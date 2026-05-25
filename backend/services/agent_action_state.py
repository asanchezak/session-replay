_pending_actions: dict[str, str] = {}


def set_pending_action(run_id: str, action: str) -> dict[str, str | bool]:
    _pending_actions[run_id] = action
    return {"accepted": True, "pending_action": action}

