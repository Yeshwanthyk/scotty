import * as stylex from "@stylexjs/stylex";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Copy, Link2, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  AdminAppShell,
  AdminEmpty,
  AdminError,
  AdminPage,
  AdminRow,
  AdminRows,
  AdminSection,
  AdminStatus,
} from "../components/AdminPage";
import { Button } from "../components/Button";
import {
  cancelOwnerTransfer,
  issuePairing,
  readCurrentPrincipal,
  readDevices,
  revokeDevice,
  startOwnerTransfer,
  type OwnerTransfer,
  type PairingGrant,
  type QrMatrix,
} from "../data/admin";
import { readSessionList } from "../data/session-list-reader";
import { sessionListFixtures } from "../fixtures/sessions";
import { colors, spacing } from "../theme/tokens.stylex";

export const Route = createFileRoute("/devices")({
  loader: async ({ abortController }) => {
    const options = { signal: abortController.signal };
    const [principal, sessions] = await Promise.all([
      readCurrentPrincipal(options),
      readSessionList({
        fixture: sessionListFixtures,
        fixtureFallback: import.meta.env.DEV,
        signal: abortController.signal,
      }),
    ]);
    const devices =
      principal.ok && principal.value.role === "owner" ? await readDevices(options) : null;
    return { devices, principal, sessions };
  },
  component: DevicesRoute,
});

const styles = stylex.create({
  issueRow: {
    display: "flex",
    alignItems: "center",
    gap: spacing.sm,
    "@media (max-width: 600px)": { alignItems: "stretch", flexDirection: "column" },
  },
  input: {
    minWidth: 0,
    height: "44px",
    paddingInline: spacing.md,
    flex: 1,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.line,
    borderRadius: "8px",
    outline: 0,
    backgroundColor: colors.control,
    color: colors.ink,
    fontSize: "13px",
    ":focus": { borderColor: colors.focus },
    "::placeholder": { color: colors.muted },
  },
  share: {
    paddingBlock: spacing.lg,
    display: "grid",
    gridTemplateColumns: "132px minmax(0, 1fr)",
    alignItems: "center",
    gap: spacing.xl,
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: colors.line,
    "@media (max-width: 600px)": { gridTemplateColumns: "1fr", gap: spacing.md },
  },
  qr: { width: "132px", height: "132px", display: "block", borderRadius: "6px" },
  shareCopy: { minWidth: 0, display: "grid", gap: spacing.sm, justifyItems: "start" },
  shareLabel: { margin: 0, color: colors.ink, fontSize: "13px", fontWeight: 650 },
  link: {
    width: "100%",
    margin: 0,
    overflow: "hidden",
    color: colors.muted,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "11px",
    lineHeight: 1.5,
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});

const dateTimeLabel = (value: string): string =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );

function QrCanvas({ matrix }: { readonly matrix: QrMatrix }) {
  const reference = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = reference.current;
    const context = canvas?.getContext("2d");
    if (canvas === null || context === null || context === undefined) return;
    const quiet = 4;
    const scale = 4;
    const modules = matrix.size + quiet * 2;
    canvas.width = modules * scale;
    canvas.height = modules * scale;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#0a0a0a";
    matrix.rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x += 1)
        if (row[x] === "1")
          context.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
    });
  }, [matrix]);
  return <canvas ref={reference} aria-label="Pairing QR code" {...stylex.props(styles.qr)} />;
}

function ShareLink({ grant }: { readonly grant: PairingGrant | OwnerTransfer }) {
  const [copied, setCopied] = useState(false);
  if (grant.url === undefined || grant.qr === undefined) return null;
  const copy = (): void => {
    void navigator.clipboard.writeText(grant.url ?? "").then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    });
  };
  return (
    <div {...stylex.props(styles.share)}>
      <QrCanvas matrix={grant.qr} />
      <div {...stylex.props(styles.shareCopy)}>
        <p {...stylex.props(styles.shareLabel)}>Open this link on the other device</p>
        <code title={grant.url} {...stylex.props(styles.link)}>
          {grant.url}
        </code>
        <Button onClick={copy} variant="quiet">
          <Copy aria-hidden width={15} height={15} />
          {copied ? "Copied" : "Copy link"}
        </Button>
        <AdminStatus tone="warning">Expires {dateTimeLabel(grant.expiresAt)}</AdminStatus>
      </div>
    </div>
  );
}

function DevicesRoute() {
  const { devices, principal, sessions } = Route.useLoaderData();
  const router = useRouter();
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<PairingGrant | null>(null);
  const [issuedTransfer, setIssuedTransfer] = useState<OwnerTransfer | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [confirmTransfer, setConfirmTransfer] = useState<string | null>(null);
  const transfer = issuedTransfer ?? (devices?.ok === true ? devices.value.transfer : null);

  const issue = (): void => {
    if (busy !== null) return;
    setBusy("pairing");
    setError(null);
    void issuePairing(label.trim())
      .then((result) => {
        if (result.ok) {
          setPairing(result.value);
          setLabel("");
        } else setError(result.failure.message);
      })
      .finally(() => setBusy(null));
  };

  const revoke = (id: string): void => {
    if (confirmRevoke !== id) {
      setConfirmRevoke(id);
      return;
    }
    setBusy(id);
    setError(null);
    void revokeDevice(id)
      .then(async (result) => {
        if (!result.ok) setError(result.failure.message);
        else {
          setConfirmRevoke(null);
          await router.invalidate();
        }
      })
      .finally(() => setBusy(null));
  };

  const beginTransfer = (id: string): void => {
    if (confirmTransfer !== id) {
      setConfirmTransfer(id);
      return;
    }
    setBusy(id);
    setError(null);
    void startOwnerTransfer(id)
      .then((result) => {
        if (result.ok) {
          setIssuedTransfer(result.value);
          setConfirmTransfer(null);
        } else setError(result.failure.message);
      })
      .finally(() => setBusy(null));
  };

  const cancelTransfer = (): void => {
    if (transfer === null || busy !== null) return;
    setBusy("transfer");
    setError(null);
    void cancelOwnerTransfer(transfer.id)
      .then(async (result) => {
        if (!result.ok) setError(result.failure.message);
        else {
          setIssuedTransfer(null);
          await router.invalidate();
        }
      })
      .finally(() => setBusy(null));
  };

  return (
    <AdminAppShell sessions={sessions} title="Devices">
      <AdminPage
        title="Devices"
        description="Manage browser access and choose the single primary device."
        action={
          <Button onClick={() => void router.invalidate()} variant="quiet">
            <RefreshCw aria-hidden width={15} height={15} />
            Refresh
          </Button>
        }
      >
        {!principal.ok ? (
          <AdminError>{principal.failure.message}</AdminError>
        ) : principal.value.role !== "owner" ? (
          <AdminError>Open this page from the primary device to manage browser access.</AdminError>
        ) : devices === null || !devices.ok ? (
          <AdminError>
            {devices?.ok === false ? devices.failure.message : "Device authority is unavailable."}
          </AdminError>
        ) : (
          <>
            {error === null ? null : <AdminError>{error}</AdminError>}
            <AdminSection
              title="Pair another browser"
              description="Create a one-time link for a phone, tablet, or another computer."
            >
              <div {...stylex.props(styles.issueRow)}>
                <input
                  aria-label="Device label"
                  maxLength={80}
                  placeholder="Phone, laptop, tablet…"
                  value={label}
                  onChange={(event) => setLabel(event.currentTarget.value)}
                  {...stylex.props(styles.input)}
                />
                <Button disabled={busy !== null} onClick={issue} variant="primary">
                  <Link2 aria-hidden width={15} height={15} />
                  {busy === "pairing" ? "Creating…" : "Create pairing"}
                </Button>
              </div>
              {pairing === null ? null : <ShareLink grant={pairing} />}
            </AdminSection>
            {transfer === null ? null : (
              <AdminSection
                title="Primary-device transfer"
                description={`Waiting for the target device until ${dateTimeLabel(transfer.expiresAt)}.`}
                action={
                  <Button disabled={busy !== null} onClick={cancelTransfer} variant="quiet">
                    {busy === "transfer" ? "Cancelling…" : "Cancel transfer"}
                  </Button>
                }
              >
                {transfer.url === undefined ? (
                  <AdminStatus tone="warning">Transfer pending</AdminStatus>
                ) : (
                  <ShareLink grant={transfer} />
                )}
              </AdminSection>
            )}
            <AdminSection
              title="Browsers with access"
              description="Primary is server authority. This device identifies the current cookie."
            >
              {devices.value.clients.length === 0 ? (
                <AdminEmpty>No registered browser was returned.</AdminEmpty>
              ) : (
                <AdminRows>
                  {devices.value.clients.map((client) => (
                    <AdminRow
                      key={client.id}
                      title={client.label || "Browser"}
                      description={`${client.id} · last used ${dateTimeLabel(client.lastSeenAt)}`}
                      aside={
                        <>
                          {client.role === "owner" ? (
                            <AdminStatus tone="good">Primary</AdminStatus>
                          ) : null}
                          {client.current ? <AdminStatus>This device</AdminStatus> : null}
                          {client.role === "standard" ? (
                            <>
                              <Button
                                disabled={busy !== null || transfer !== null}
                                onClick={() => beginTransfer(client.id)}
                                variant="quiet"
                              >
                                {confirmTransfer === client.id ? "Confirm primary" : "Make primary"}
                              </Button>
                              <Button
                                disabled={busy !== null}
                                onClick={() => revoke(client.id)}
                                variant="quiet"
                              >
                                {confirmRevoke === client.id ? "Confirm revoke" : "Revoke"}
                              </Button>
                            </>
                          ) : null}
                        </>
                      }
                    />
                  ))}
                </AdminRows>
              )}
            </AdminSection>
          </>
        )}
      </AdminPage>
    </AdminAppShell>
  );
}
