"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Notice } from "@/components/ui";
import { acceptInviteAction, type JoinResult } from "./actions";

// The secret is kept in this tab only (sessionStorage) while the person signs in, then removed.
const KEY = "ynms-team-invite";

export function JoinClient() {
  const router = useRouter();
  const [state, setState] = useState<
    JoinResult | { kind: "working" } | { kind: "missing" }
  >({ kind: "working" });

  useEffect(() => {
    const fromHash = window.location.hash.replace(/^#/, "");
    if (fromHash) {
      try {
        sessionStorage.setItem(KEY, fromHash);
      } catch {}
      history.replaceState(null, "", window.location.pathname);
    }
    let token = fromHash;
    if (!token) {
      try {
        token = sessionStorage.getItem(KEY) ?? "";
      } catch {}
    }
    const ask: Promise<JoinResult | { kind: "missing" }> = token
      ? acceptInviteAction(token).catch((): JoinResult => ({
          kind: "error",
          message:
            "Could not reach the server. Check your connection and open the link again.",
        }))
      : Promise.resolve({ kind: "missing" as const });
    void ask.then((res) => {
      if (res.kind !== "signed_out" && res.kind !== "needs_code") {
        try {
          sessionStorage.removeItem(KEY);
        } catch {}
      }
      setState(res);
      if (res.kind === "joined") router.replace("/app");
    });
  }, [router]);

  if (state.kind === "working")
    return (
      <p role="status" className="text-ink-body">
        Checking your invitation…
      </p>
    );
  if (state.kind === "joined")
    return (
      <p role="status" className="text-ink-body">
        You have joined the team. Opening it…
      </p>
    );
  if (state.kind === "missing")
    return (
      <Notice tone="danger">
        No invitation was found in this link. Open the whole link from the
        message you were sent.
      </Notice>
    );
  if (state.kind === "signed_out")
    return (
      <div className="flex flex-col gap-4">
        <p className="text-base text-ink-body">
          Sign in with the email address the invitation was sent to. If you do
          not have an account yet, create one with that address first, then open
          the invitation link again.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link
            href="/login?next=/join"
            className="inline-flex min-h-11 items-center rounded-pill bg-ink px-6 text-base font-medium text-on-ink no-underline"
          >
            Sign in
          </Link>
          <Link
            href="/signup"
            className="inline-flex min-h-11 items-center rounded-pill border border-control-border px-6 text-base text-ink no-underline"
          >
            Create an account
          </Link>
        </div>
      </div>
    );
  if (state.kind === "needs_code")
    return (
      <div className="flex flex-col gap-4">
        <p className="text-base text-ink-body">
          Your account uses two-step sign-in. Enter your authenticator code
          first; you will come back here to join.
        </p>
        <div>
          <Link
            href="/mfa?next=/join"
            className="inline-flex min-h-11 items-center rounded-pill bg-ink px-6 text-base font-medium text-on-ink no-underline"
          >
            Enter my code
          </Link>
        </div>
      </div>
    );
  return <Notice tone="danger">{state.message}</Notice>;
}
