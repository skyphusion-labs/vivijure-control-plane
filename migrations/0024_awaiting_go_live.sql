-- The tenant never pastes a RunPod key. awaiting_invoke_key was the BYOK
-- parking name. Same state, honest name.
UPDATE tenants SET status = 'awaiting_go_live' WHERE status = 'awaiting_invoke_key';
