import { profileTitle, profileWeeklyQuotaLabel } from "./auth-profile-display.js";
import { evaluateAuthProfile, isAuthProfileProbeFailure, isAuthProfileProbeFailureReason } from "../services/session-auth-profile-selector.js";

type SessionRecord = Record<string, any>;

export interface SessionMetaPill {
  readonly key: string;
  readonly label: string;
  readonly tone: string;
  readonly title?: string;
}

export interface SessionQueueState {
  readonly label: string;
  readonly tone: string;
  readonly rank: number;
  readonly detail: string;
}

export interface SessionWorkIndicator {
  readonly value: string;
  readonly detail: string;
  readonly tone: string;
  readonly title: string;
}

export interface SessionInboundIndicator {
  readonly value: string;
  readonly detail: string;
  readonly tone: string;
  readonly title: string;
}

export function shouldShowSessionState(state: { readonly rank: number }): boolean {
  return state.rank > 10;
}

export function buildChannelLabelById(sessions: readonly SessionRecord[]): ReadonlyMap<string, string> {
  const labels = new Map<string, string>();
  for (const session of sessions) {
    const channelId = String(session.channelId || "");
    const label = sessionHumanChannelLabel(session);
    if (channelId && label) {
      labels.set(channelId, label);
    }
  }
  return labels;
}

export function resolveSessionChannelLabel(session: SessionRecord, channelLabelById?: ReadonlyMap<string, string>): string {
  const channelId = String(session.channelId || "");
  return sessionHumanChannelLabel(session) || (channelId ? channelLabelById?.get(channelId) : undefined) || channelId || "未知频道";
}

export function renderSessionMeta(session: SessionRecord, authProfileByName: ReadonlyMap<string, SessionRecord>, channelLabelById?: ReadonlyMap<string, string>): SessionMetaPill[] {
  const usage = session.usage || {};
  const inboundIndicator = sessionInboundIndicator(session);
  const authProfile = session.authProfileName ? authProfileByName.get(String(session.authProfileName)) : null;
  const activeJobCount = activeBackgroundJobCount(session);
  const authBlockActive = sessionAuthBlockActive(session, authProfile);
  return [
    platformPill(session),
    { key: "channel", label: resolveSessionChannelLabel(session, channelLabelById), tone: "info", title: stringOrUndefined(session.channelId || session.key) },
    authBlockActive ? { key: "auth-blocked", label: "账号待切换", tone: "danger", title: stringOrUndefined(session.authBlockReasonLabel || session.authBlockReason) } : null,
    session.authProfileName
      ? {
          key: "auth-profile",
          label: authProfile ? profileWeeklyQuotaLabel(authProfile) : "账号已绑定",
          tone: "info",
          title: authProfile ? profileTitle(authProfile) : String(session.authProfileName),
        }
      : null,
    inboundIndicator ? { key: "pending", label: "未读/待处理 " + inboundIndicator.value, tone: inboundIndicator.tone, title: inboundIndicator.title + " · " + inboundIndicator.detail } : null,
    activeJobCount > 0 ? { key: "jobs", label: "Jobs " + activeJobCount, tone: "good" } : null,
    { key: "tokens", label: "Token " + formatSessionTokens(usage.totalTokens || 0), tone: "info" },
  ].filter((item): item is SessionMetaPill => Boolean(item));
}

export function sessionQueueState(session: SessionRecord, authProfile?: SessionRecord | null | undefined): SessionQueueState {
  if (sessionAuthBlockActive(session, authProfile)) {
    return { label: "账号待切换", tone: "danger", rank: 70, detail: String(session.authBlockReasonLabel || session.authBlockReason || "账号不可用") };
  }
  if (Number(session.openHumanInboundCount || 0) > 0) {
    return { label: "待处理", tone: "warn", rank: 50, detail: session.openHumanInboundCount + " 条未处理用户消息" };
  }
  if (Number(session.openInboundCount || 0) > 0) {
    return { label: "待处理", tone: "warn", rank: 40, detail: session.openInboundCount + " 条未处理系统消息" };
  }
  if (session.activeTurnId) {
    const indicator = sessionWorkIndicator(session);
    return { label: "处理中", tone: "good", rank: 30, detail: indicator?.detail ?? shortValue(session.activeTurnId, 18) };
  }
  const activeJobCount = activeBackgroundJobCount(session);
  if (activeJobCount > 0) {
    return { label: "后台任务", tone: "good", rank: 20, detail: activeJobCount + " 个运行任务" };
  }
  if (Number(session.usage?.turnCount || 0) > 0) {
    return { label: "有记录", tone: "info", rank: 10, detail: formatSessionTokens(session.usage?.totalTokens || 0) };
  }
  return { label: "空闲", tone: "", rank: 0, detail: "" };
}

export function sessionWorkIndicator(session: SessionRecord): SessionWorkIndicator | null {
  if (!session.activeTurnId) {
    return null;
  }

  const turnId = shortValue(session.activeTurnId, 18);
  const platform = String(session.platform || "slack");
  if (platform === "feishu") {
    return {
      value: "飞书状态卡",
      detail: `状态卡 / 消息更新 · ${turnId}`,
      tone: "good",
      title: "Feishu native typing is not assumed; dashboard parity is the visible state card or message update for the active turn.",
    };
  }
  if (platform === "slack") {
    return {
      value: "Slack 状态",
      detail: `assistant status / eyes fallback · ${turnId}`,
      tone: "good",
      title: "Slack active turns expose work status through assistant.threads.setStatus, with eyes reaction fallback when the API is unavailable.",
    };
  }
  return {
    value: "处理中",
    detail: turnId,
    tone: "good",
    title: "Active broker turn",
  };
}

export function sessionInboundIndicator(session: SessionRecord): SessionInboundIndicator | null {
  const openInbound = Math.max(0, Number(session.openInboundCount || 0));
  if (openInbound <= 0) {
    return null;
  }

  const openHumanInbound = Math.max(0, Number(session.openHumanInboundCount || 0));
  const openSystemInbound = Math.max(0, Number(session.openSystemInboundCount || Math.max(0, openInbound - openHumanInbound)));
  const platform = String(session.platform || "slack");
  const platformSurface = platform === "feishu" ? "Feishu group" : platform === "slack" ? "Slack thread/channel" : "chat surface";
  return {
    value: openInbound + " 条",
    detail: "用户 " + openHumanInbound + " / 系统 " + openSystemInbound,
    tone: openHumanInbound > 0 ? "warn" : "info",
    title: `${platformSurface} broker open-inbound state; this is the product read/unread signal, not a native client unread counter.`,
  };
}

export function sessionAuthBlockActive(session: SessionRecord, authProfile?: SessionRecord | null | undefined): boolean {
  if (!session.authBlockedAt) return false;
  if (isAuthProfileProbeFailureReason(stringOrUndefined(session.authBlockReason))) return false;
  if (!authProfile) return true;
  if (session.authProfileName && authProfile.name && String(session.authProfileName) !== String(authProfile.name)) {
    return true;
  }
  try {
    const evaluation = evaluateAuthProfile(authProfile as never);
    if (isAuthProfileProbeFailure(evaluation)) return false;
    return !evaluation.usable;
  } catch {
    return true;
  }
}

export function sessionActivityAt(session: SessionRecord): unknown {
  const candidates = [
    session.lastActivityAt,
    session.lastTurnSignalAt,
    session.lastSlackReplyAt,
    session.activeTurnStartedAt,
    session.usage?.lastTurnAt,
    ...(session.openInbound || []).map((message: Record<string, any>) => message.updatedAt || message.createdAt),
    ...(session.backgroundJobs || []).flatMap(jobActivityTimestamps),
    ...(session.failedBackgroundJobs || []).flatMap(jobActivityTimestamps),
  ];
  const latestMs = newestTimestamp(candidates);
  return candidates.find((value) => timestampMs(value) === latestMs) || session.createdAt || session.updatedAt;
}

export function sessionActivityMs(session: SessionRecord): number {
  return timestampMs(sessionActivityAt(session));
}

export function activeBackgroundJobs(session: SessionRecord): Record<string, any>[] {
  const jobs = Array.isArray(session.backgroundJobs) ? session.backgroundJobs : null;
  return jobs ? jobs.filter(isActiveBackgroundJob) : [];
}

export function activeBackgroundJobCount(session: SessionRecord): number {
  if (Array.isArray(session.backgroundJobs)) {
    return activeBackgroundJobs(session).length;
  }
  return Math.max(0, Number(session.runningBackgroundJobCount || 0));
}

export function isActiveBackgroundJob(job: Record<string, any>): boolean {
  const status = String(job.status || "").toLowerCase();
  return status === "registered" || status === "running";
}

function sessionHumanChannelLabel(session: SessionRecord): string | undefined {
  const channelId = String(session.channelId || "");
  const channelName = String(session.channelName || "").trim();
  if (channelName) {
    return formatSlackChannelName(channelName);
  }

  const channelLabel = String(session.channelLabel || "").trim();
  if (channelLabel && channelLabel !== channelId && !looksLikeSlackChannelId(channelLabel)) {
    return channelLabel;
  }

  if (session.channelType === "im") return "私信";
  if (session.channelType === "mpim") return "群聊";
  return undefined;
}

function platformPill(session: SessionRecord): SessionMetaPill | null {
  const platform = String(session.platform || "").trim();
  if (platform === "feishu") {
    return {
      key: "platform",
      label: "飞书",
      tone: "good",
      title: "Feishu session",
    };
  }
  if (platform === "slack") {
    return {
      key: "platform",
      label: "Slack",
      tone: "info",
      title: "Slack session",
    };
  }
  return null;
}

function formatSessionTokens(value: unknown): string {
  const count = Math.max(0, Number(value || 0));
  if (count >= 1000000) return (count / 1000000).toFixed(2).replace(/\.00$/, "") + "M";
  if (count >= 1000) return (count / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(Math.round(count));
}

function shortValue(value: unknown, maxLength: number): string {
  const text = String(value || "");
  if (text.length <= maxLength) return text;
  return text.slice(0, Math.max(4, maxLength - 5)) + "..." + text.slice(-4);
}

function formatSlackChannelName(channelName: string): string {
  return channelName.startsWith("#") ? channelName : "#" + channelName;
}

function looksLikeSlackChannelId(value: string): boolean {
  return /^[CDG][A-Z0-9]{8,}$/.test(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  const text = String(value || "");
  return text || undefined;
}

function jobActivityTimestamps(job: Record<string, any>): unknown[] {
  return [job.lastEventAt, job.status === "running" ? null : job.updatedAt, job.createdAt];
}

function timestampMs(value: unknown): number {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function newestTimestamp(values: readonly unknown[]): number {
  return values.reduce<number>((latest, value) => Math.max(latest, timestampMs(value)), 0);
}
