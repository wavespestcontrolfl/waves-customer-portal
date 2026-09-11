import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActionFeedback,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
} from "../../../components/ui";
import { adminFetch } from "../../../utils/admin-fetch";
import { formatDate, parseObject } from "./config";

// Pre-migration status text: the ASCII glyph prefix is operator-facing copy
// and stays verbatim (AGENTS.md L230-231).
const TOKEN_STATUS_ICONS = {
  healthy: "OK",
  expired: "X",
  "expiring-soon": "!",
  error: "X",
  unknown: "?",
};

function tokenTone(status) {
  return ["expired", "expiring-soon", "error"].includes(status) ? "alert" : "neutral";
}

export default function TokensTab({ showFeedback }) {
  const [tokens, setTokens] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [checkError, setCheckError] = useState("");
  const [checking, setChecking] = useState(false);
  const checkingRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const data = await adminFetch("/admin/kb/tokens/status");
      setTokens(data.tokens || []);
    } catch {
      setTokens([]);
      setLoadError("Token status could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const runCheck = async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    setCheckError("");
    try {
      const result = await adminFetch("/admin/kb/tokens/check", { method: "POST" });
      showFeedback(
        `Checked ${result.checked} tokens: ${result.healthy} healthy, ${result.failures} failed`,
      );
      load();
    } catch (error) {
      const message = error.message || "The token check could not be completed.";
      setCheckError(message);
      showFeedback(`Check failed: ${message}`, true);
    } finally {
      checkingRef.current = false;
      setChecking(false);
    }
  };

  return (
    <div className="max-w-[900px]">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-18 leading-[1.35] font-medium text-zinc-900">API token health</h2>
          <p className="mt-1 text-ui-body text-ink-secondary">
            Monitor OAuth tokens and API credentials across all platforms.
          </p>
        </div>
        <Button loading={checking} onClick={runCheck}>Run health check</Button>
      </div>

      {checking && (
        <ActionFeedback className="mb-3">Checking configured provider tokens…</ActionFeedback>
      )}
      {checkError && <ActionFeedback error className="mb-3">{checkError}</ActionFeedback>}
      {loading && <ActionFeedback className="mb-3 min-h-11">Loading token status…</ActionFeedback>}
      {loadError && (
        <ActionFeedback error onRetry={load} className="mb-3">{loadError}</ActionFeedback>
      )}

      {!loading && !loadError && tokens.length === 0 ? (
        <Card>
          <CardBody className="py-10 text-center text-ui-body text-ink-secondary">
            No token data yet -- run a health check to initialize
          </CardBody>
        </Card>
      ) : (
        <div className="grid gap-3">
          {tokens.map((token) => {
            const metadata = parseObject(token.metadata);
            const attention = ["expired", "expiring-soon", "error"].includes(token.status);
            return (
              <Card key={token.id} className={attention ? "border-alert-fg" : undefined}>
                <CardHeader className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle>{token.platform}</CardTitle>
                    <div className="mt-1 break-all text-ui-caption text-ink-secondary">
                      {token.env_var_name}
                    </div>
                  </div>
                  <Badge tone={tokenTone(token.status)}>
                    {TOKEN_STATUS_ICONS[token.status]} {token.status}
                  </Badge>
                </CardHeader>
                <CardBody>
                  {token.last_error && (
                    <ActionFeedback error className="mb-3">
                      {token.last_error.substring(0, 200)}
                    </ActionFeedback>
                  )}
                  <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-ui-caption text-ink-secondary u-nums">
                    {token.expires_at && <span>Expires: {formatDate(token.expires_at)}</span>}
                    {token.last_verified_at && (
                      <span>Last checked: {formatDate(token.last_verified_at, true)}</span>
                    )}
                    {metadata.ttl && <span>TTL: {metadata.ttl}</span>}
                    {metadata.authUrl && (
                      <a
                        href={metadata.authUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded-sm text-zinc-900 underline underline-offset-2 u-focus-ring"
                      >
                        Re-authorize
                      </a>
                    )}
                    {metadata.refreshUrl && (
                      <a
                        href={metadata.refreshUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded-sm text-zinc-900 underline underline-offset-2 u-focus-ring"
                      >
                        Refresh token
                      </a>
                    )}
                  </div>
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
