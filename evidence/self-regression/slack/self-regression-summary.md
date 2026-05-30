# slack self-regression

mode: drive
checked_at: 2026-05-30T18:07:47.338Z
status: PASS

- [PASS] slack.drive.message_posted: Slack drive posted a controlled user message
  - evidence: channel=#xp-test
  - evidence: channel_resolved_by=bot
  - evidence: ts=1780164470.917659
- [PASS] slack.drive.session_accepted: Slack drive message was accepted by the broker before file upload
  - evidence: chat.message.accepted platform=slack sessionKey=C0ALMF2AD70:1780164470.917659 conversationId=C0ALMF2AD70 rootMessageId=1780164470.917659 messageId=1780164470.917659
- [PASS] slack.drive.file_posted: Slack drive exercised a controlled file upload
  - evidence: channel=#xp-test
  - evidence: rootMessageId=1780164470.917659
  - evidence: file=self-regression.txt
- [PASS] runtime.slack_ready: Slack reports ready in the broker runtime
  - evidence: platforms.slack.state=ready
- [PASS] slack.socket_mode_ready: Slack Socket Mode reached ready state
  - evidence: connectionMode=unknown
  - evidence: chat.platform.ready platform=slack source=socket_mode
- [PASS] slack.message_roundtrip: Slack accepted an inbound message and posted an outbound reply
  - evidence: chat.message.accepted platform=slack sessionKey=C0ALMF2AD70:1780164470.917659 conversationId=C0ALMF2AD70 rootMessageId=1780164470.917659 messageId=1780164470.917659
  - evidence: chat.outbound.posted platform=slack sessionKey=C0ALMF2AD70:1780164470.917659 conversationId=C0ALMF2AD70 rootMessageId=1780164470.917659 format=file
- [PASS] slack.work_status_visible: Slack work status or fallback reaction evidence is present
  - evidence: slack.assistant.status.updated platform=slack sessionKey=C0ALMF2AD70:1780164470.917659 conversationId=C0ALMF2AD70 rootMessageId=1780164470.917659
- [PASS] slack.file_artifact_path: Slack file/artifact path was exercised or explicitly unavailable
  - evidence: chat.outbound.posted platform=slack sessionKey=C0ALMF2AD70:1780164470.917659 conversationId=C0ALMF2AD70 rootMessageId=1780164470.917659 format=file
