import * as stylex from "@stylexjs/stylex";
import { CircleAlert, RefreshCw, Send, Wifi, WifiOff } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  type ConversationFailure,
  type ConversationQueueItem,
  type ConversationSnapshot,
  isConversationLifecycleMismatch,
  readConversation,
  steerConversation,
} from "../data/conversation-client";
import { colors, motion, spacing } from "../theme/tokens.stylex";
import { Button } from "./Button";
import { Conversation } from "./Conversation";

const ACTIVE_POLL_MS = 750;
const IDLE_POLL_MS = 2_500;
const RETRY_POLL_MS = 1_500;
const MAX_MESSAGE_BYTES = 16 * 1024;

type ConnectionState =
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly snapshot: ConversationSnapshot;
      readonly connection: "connected" | "paused" | "reconnecting";
      readonly detail?: string;
    }
  | { readonly kind: "paused"; readonly detail: string }
  | { readonly kind: "unavailable"; readonly failure: ConversationFailure };

type DeliveryState =
  | { readonly kind: "idle" }
  | { readonly kind: "submitting" }
  | { readonly kind: "accepted"; readonly message: string }
  | { readonly kind: "failed" | "ambiguous"; readonly message: string };

const styles = stylex.create({
  root: {
    height: "100%",
    minHeight: 0,
    display: "grid",
    gridTemplateRows: "auto minmax(0, 1fr) auto",
  },
  connection: {
    minHeight: "34px",
    paddingInline: "clamp(0px, 1vw, 12px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: colors.lineSoft,
    color: colors.quiet,
    fontSize: "11px",
  },
  connectionIdentity: { display: "inline-flex", alignItems: "center", gap: "6px" },
  connectionIcon: { width: "12px", height: "12px", color: colors.success, strokeWidth: 2 },
  reconnectingIcon: { color: colors.warning },
  unavailableIcon: { color: colors.danger },
  connectionDetail: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  skeleton: {
    minHeight: 0,
    padding: "36px clamp(16px, 5vw, 52px)",
    display: "grid",
    alignContent: "start",
    gap: spacing.lg,
  },
  skeletonLine: {
    height: "12px",
    borderRadius: "4px",
    backgroundColor: colors.lineSoft,
  },
  skeletonLong: { width: "72%" },
  skeletonShort: { width: "46%" },
  empty: {
    minHeight: 0,
    padding: spacing.xl,
    display: "grid",
    placeItems: "center",
    textAlign: "center",
  },
  emptyInner: {
    width: "min(440px, 100%)",
    display: "grid",
    justifyItems: "center",
    gap: spacing.md,
  },
  emptyIcon: { width: "20px", height: "20px", color: colors.muted, strokeWidth: 1.7 },
  emptyTitle: { margin: 0, color: colors.ink, fontSize: "15px", fontWeight: 650 },
  emptyCopy: {
    maxWidth: "64ch",
    margin: 0,
    color: colors.muted,
    fontSize: "13px",
    lineHeight: 1.6,
  },
  composer: {
    padding: `${spacing.md} clamp(0px, 3vw, 32px) ${spacing.lg}`,
    display: "grid",
    justifyItems: "center",
    gap: spacing.sm,
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: colors.lineSoft,
    backgroundColor: colors.space,
    boxShadow: "0 -16px 32px rgb(0 0 0 / 0.18)",
    "@media (max-width: 720px)": { paddingBottom: spacing.md },
  },
  composerControl: {
    width: "min(840px, 100%)",
    minHeight: "52px",
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    alignItems: "end",
    gap: spacing.sm,
    padding: "7px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.line,
    borderRadius: "14px",
    backgroundColor: colors.control,
    boxShadow: "0 1px 0 rgb(255 255 255 / 0.04) inset, 0 10px 28px rgb(0 0 0 / 0.2)",
    transitionProperty: "width, min-height, border-color, background-color, box-shadow",
    transitionDuration: motion.standard,
    transitionTimingFunction: motion.easeOut,
    ":focus-within": {
      width: "min(1040px, 100%)",
      minHeight: "92px",
      borderColor: colors.focus,
      backgroundColor: colors.panelRaised,
      boxShadow:
        "0 0 0 3px rgb(126 217 232 / 0.1), 0 1px 0 rgb(255 255 255 / 0.05) inset, 0 12px 32px rgb(0 0 0 / 0.26)",
    },
  },
  input: {
    width: "100%",
    minHeight: "32px",
    maxHeight: "128px",
    padding: "7px 8px",
    resize: "none",
    overflowY: "auto",
    borderWidth: 0,
    outline: 0,
    backgroundColor: "transparent",
    color: colors.ink,
    fontSize: "13px",
    lineHeight: 1.5,
    transitionProperty: "min-height",
    transitionDuration: motion.standard,
    transitionTimingFunction: motion.easeOut,
    ":focus": { minHeight: "68px" },
    "::placeholder": { color: colors.muted },
  },
  composerFooter: {
    width: "min(1040px, 100%)",
    minHeight: "16px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    color: colors.quiet,
    fontSize: "10px",
  },
  deliveryError: { color: colors.danger },
  deliveryWarning: { color: colors.warning },
  sendIcon: { width: "14px", height: "14px", strokeWidth: 1.8 },
  queue: {
    width: "min(1040px, 100%)",
    margin: 0,
    padding: 0,
    display: "grid",
    gap: "4px",
    listStyle: "none",
  },
  queueItem: {
    minWidth: 0,
    padding: "6px 8px",
    display: "grid",
    gridTemplateColumns: "18px minmax(0, 1fr) auto",
    alignItems: "center",
    gap: spacing.sm,
    borderRadius: "7px",
    backgroundColor: "rgb(255 255 255 / 0.035)",
    color: colors.muted,
    fontSize: "11px",
  },
  queueOrder: {
    color: colors.quiet,
    fontVariantNumeric: "tabular-nums",
    textAlign: "center",
  },
  queueText: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  queueMode: { color: colors.quiet, fontSize: "10px" },
});

const failureMessage = (failure: ConversationFailure): string =>
  failure.kind === "http" ? (failure.hint ?? failure.message) : failure.message;

export const conversationPollDelay = (snapshot: ConversationSnapshot): number =>
  snapshot.turns.some((turn) => turn.state === "streaming") ? ACTIVE_POLL_MS : IDLE_POLL_MS;

function ConversationSkeleton() {
  return (
    <div aria-label="Loading conversation" aria-busy="true" {...stylex.props(styles.skeleton)}>
      <span {...stylex.props(styles.skeletonLine, styles.skeletonLong)} />
      <span {...stylex.props(styles.skeletonLine, styles.skeletonShort)} />
      <span {...stylex.props(styles.skeletonLine, styles.skeletonLong)} />
    </div>
  );
}

function EmptyConversation() {
  return (
    <div {...stylex.props(styles.empty)}>
      <div {...stylex.props(styles.emptyInner)}>
        <Wifi aria-hidden {...stylex.props(styles.emptyIcon)} />
        <h3 {...stylex.props(styles.emptyTitle)}>Runtime connected</h3>
        <p {...stylex.props(styles.emptyCopy)}>
          The conversation is ready. Send a message below to begin working with this session.
        </p>
      </div>
    </div>
  );
}

function UnavailableConversation({
  failure,
  retry,
}: {
  readonly failure: ConversationFailure;
  readonly retry: () => void;
}) {
  return (
    <div role="alert" {...stylex.props(styles.empty)}>
      <div {...stylex.props(styles.emptyInner)}>
        <CircleAlert aria-hidden {...stylex.props(styles.emptyIcon, styles.unavailableIcon)} />
        <h3 {...stylex.props(styles.emptyTitle)}>Conversation unavailable</h3>
        <p {...stylex.props(styles.emptyCopy)}>{failureMessage(failure)}</p>
        <Button onClick={retry} variant="primary">
          <RefreshCw aria-hidden {...stylex.props(styles.sendIcon)} />
          Try again
        </Button>
      </div>
    </div>
  );
}

function useConversationConnection(
  sessionId: string,
  runtimeAvailable: boolean,
  onLifecycleMismatch: () => void,
) {
  const [connection, setConnection] = useState<ConnectionState>({ kind: "loading" });
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const verifiedSnapshot = useRef<
    { readonly sessionId: string; readonly snapshot: ConversationSnapshot } | undefined
  >(undefined);

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    let lastSnapshot =
      verifiedSnapshot.current?.sessionId === sessionId
        ? verifiedSnapshot.current.snapshot
        : undefined;

    if (!runtimeAvailable) {
      setConnection(
        lastSnapshot === undefined
          ? { kind: "paused", detail: "Resume this session to continue the conversation." }
          : {
              kind: "ready",
              snapshot: lastSnapshot,
              connection: "paused",
              detail: "The transcript is retained. Resume to continue.",
            },
      );
      return;
    }

    const poll = async (): Promise<void> => {
      controller = new AbortController();
      const result = await readConversation(sessionId, { signal: controller.signal });
      if (stopped) return;
      if (result.ok) {
        lastSnapshot = result.snapshot;
        verifiedSnapshot.current = { sessionId, snapshot: result.snapshot };
        setConnection({ kind: "ready", snapshot: result.snapshot, connection: "connected" });
        timer = window.setTimeout(() => void poll(), conversationPollDelay(result.snapshot));
        return;
      }
      if (isConversationLifecycleMismatch(result.failure)) {
        setConnection(
          lastSnapshot === undefined
            ? { kind: "paused", detail: failureMessage(result.failure) }
            : {
                kind: "ready",
                snapshot: lastSnapshot,
                connection: "paused",
                detail: "The transcript is retained. Resume to continue.",
              },
        );
        onLifecycleMismatch();
        return;
      }
      if (lastSnapshot === undefined)
        setConnection({ kind: "unavailable", failure: result.failure });
      else
        setConnection({
          kind: "ready",
          snapshot: lastSnapshot,
          connection: "reconnecting",
          detail: failureMessage(result.failure),
        });
      timer = window.setTimeout(() => void poll(), RETRY_POLL_MS);
    };

    if (lastSnapshot === undefined) setConnection({ kind: "loading" });
    void poll();
    return () => {
      stopped = true;
      controller?.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [onLifecycleMismatch, refreshGeneration, runtimeAvailable, sessionId]);

  return {
    connection,
    refresh: () => setRefreshGeneration((current) => current + 1),
  };
}

const connectionLabelFor = (connection: ConnectionState, active: boolean): string => {
  if (connection.kind === "loading") return "Connecting";
  if (connection.kind === "paused") return "Session paused";
  if (connection.kind === "unavailable") return "Unavailable";
  if (connection.connection === "paused") return "Session paused";
  if (connection.connection === "reconnecting") return "Reconnecting";
  return active ? "Live · working" : "Live · ready";
};

function ConnectionStatus({
  active,
  connection,
}: {
  readonly active: boolean;
  readonly connection: ConnectionState;
}) {
  const reconnecting =
    connection.kind === "loading" ||
    (connection.kind === "ready" && connection.connection === "reconnecting");
  return (
    <div role="status" aria-live="polite" {...stylex.props(styles.connection)}>
      <span {...stylex.props(styles.connectionIdentity)}>
        {connection.kind === "unavailable" || connection.kind === "paused" ? (
          <WifiOff aria-hidden {...stylex.props(styles.connectionIcon, styles.unavailableIcon)} />
        ) : (
          <Wifi
            aria-hidden
            {...stylex.props(styles.connectionIcon, reconnecting && styles.reconnectingIcon)}
          />
        )}
        {connectionLabelFor(connection, active)}
      </span>
      {connection.kind === "ready" && connection.detail !== undefined ? (
        <span {...stylex.props(styles.connectionDetail)}>{connection.detail}</span>
      ) : null}
    </div>
  );
}

function ConversationContent({
  connection,
  retry,
}: {
  readonly connection: ConnectionState;
  readonly retry: () => void;
}) {
  if (connection.kind === "loading") return <ConversationSkeleton />;
  if (connection.kind === "paused")
    return (
      <div {...stylex.props(styles.empty)}>
        <div {...stylex.props(styles.emptyInner)}>
          <WifiOff aria-hidden {...stylex.props(styles.emptyIcon)} />
          <h3 {...stylex.props(styles.emptyTitle)}>Conversation retained</h3>
          <p {...stylex.props(styles.emptyCopy)}>{connection.detail}</p>
        </div>
      </div>
    );
  if (connection.kind === "unavailable")
    return <UnavailableConversation failure={connection.failure} retry={retry} />;
  if (connection.snapshot.turns.length === 0) return <EmptyConversation />;
  return <Conversation turns={connection.snapshot.turns} />;
}

const deliveryMessage = (delivery: DeliveryState, draftTooLong: boolean): string => {
  if (draftTooLong) return "Message is too long";
  if (delivery.kind === "accepted" || delivery.kind === "failed" || delivery.kind === "ambiguous")
    return delivery.message;
  return "";
};

function ConversationComposer({
  active,
  enabled,
  onAccepted,
  queue,
  sessionId,
}: {
  readonly active: boolean;
  readonly enabled: boolean;
  readonly onAccepted: () => void;
  readonly queue: ConversationSnapshot["queue"];
  readonly sessionId: string;
}) {
  const [draft, setDraft] = useState("");
  const [delivery, setDelivery] = useState<DeliveryState>({ kind: "idle" });
  const draftBytes = useMemo(() => new TextEncoder().encode(draft).byteLength, [draft]);
  const draftTooLong = draftBytes > MAX_MESSAGE_BYTES;
  const canSubmit =
    enabled && draft.trim().length > 0 && !draftTooLong && delivery.kind !== "submitting";
  const sendLabel = active ? "Steer" : "Send";

  const submit = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault();
    if (!canSubmit) return;
    const message = draft.trim();
    setDelivery({ kind: "submitting" });
    const result = await steerConversation(sessionId, message);
    if (result.ok) {
      setDraft("");
      setDelivery({ kind: "accepted", message: active ? "Steer accepted" : "Message accepted" });
      onAccepted();
      return;
    }
    setDelivery({
      kind: result.failure.kind === "ambiguous" ? "ambiguous" : "failed",
      message: result.failure.message,
    });
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  };

  return (
    <form onSubmit={(event) => void submit(event)} {...stylex.props(styles.composer)}>
      <ComposerQueue queue={queue} />
      <div {...stylex.props(styles.composerControl)}>
        <textarea
          aria-label="Message this session"
          disabled={!enabled}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            if (delivery.kind !== "idle") setDelivery({ kind: "idle" });
          }}
          onKeyDown={onComposerKeyDown}
          placeholder="Message this session…"
          rows={1}
          value={draft}
          {...stylex.props(styles.input)}
        />
        <Button aria-label={sendLabel} disabled={!canSubmit} type="submit" variant="primary">
          <Send aria-hidden {...stylex.props(styles.sendIcon)} />
          {delivery.kind === "submitting" ? "Sending" : sendLabel}
        </Button>
      </div>
      <div {...stylex.props(styles.composerFooter)}>
        <span>Enter to {active ? "steer" : "send"} · Shift+Enter for a new line</span>
        <span
          role={delivery.kind === "failed" || delivery.kind === "ambiguous" ? "alert" : "status"}
          {...stylex.props(
            delivery.kind === "failed" && styles.deliveryError,
            delivery.kind === "ambiguous" && styles.deliveryWarning,
          )}
        >
          {deliveryMessage(delivery, draftTooLong)}
        </span>
      </div>
    </form>
  );
}

const compactQueueText = (item: ConversationQueueItem): string => {
  const compact = item.text.replaceAll(/\s+/gu, " ").trim();
  return compact.length > 120 ? `${compact.slice(0, 119).trimEnd()}…` : compact;
};

function ComposerQueue({ queue }: { readonly queue: ConversationSnapshot["queue"] }) {
  const items = [
    ...queue.steer.map((item) => ({ item, label: "Steer" })),
    ...queue.followUp.map((item) => ({ item, label: "Queued" })),
  ];
  if (items.length === 0) return null;
  const visible = items.slice(0, 3);
  return (
    <ol aria-label="Queued messages" {...stylex.props(styles.queue)}>
      {visible.map(({ item, label }, index) => (
        <li key={`${label}-${item.id}`} {...stylex.props(styles.queueItem)}>
          <span {...stylex.props(styles.queueOrder)}>{index + 1}</span>
          <span title={item.text} {...stylex.props(styles.queueText)}>
            {compactQueueText(item)}
          </span>
          <small {...stylex.props(styles.queueMode)}>{label}</small>
        </li>
      ))}
      {items.length > visible.length ? (
        <li {...stylex.props(styles.queueItem)}>
          <span {...stylex.props(styles.queueOrder)}>+</span>
          <span {...stylex.props(styles.queueText)}>{items.length - visible.length} more</span>
          <small {...stylex.props(styles.queueMode)}>Queued</small>
        </li>
      ) : null}
    </ol>
  );
}

export function LiveConversation({
  onLifecycleMismatch,
  runtimeAvailable,
  sessionId,
}: {
  readonly onLifecycleMismatch: () => void;
  readonly runtimeAvailable: boolean;
  readonly sessionId: string;
}) {
  const { connection, refresh } = useConversationConnection(
    sessionId,
    runtimeAvailable,
    onLifecycleMismatch,
  );

  const snapshot = connection.kind === "ready" ? connection.snapshot : undefined;
  const active = snapshot?.turns.some((turn) => turn.state === "streaming") ?? false;

  return (
    <div {...stylex.props(styles.root)}>
      <ConnectionStatus active={active} connection={connection} />
      <ConversationContent connection={connection} retry={refresh} />
      <ConversationComposer
        active={active}
        enabled={connection.kind === "ready" && connection.connection === "connected"}
        onAccepted={refresh}
        queue={snapshot?.queue ?? { steer: [], followUp: [] }}
        sessionId={sessionId}
      />
    </div>
  );
}
