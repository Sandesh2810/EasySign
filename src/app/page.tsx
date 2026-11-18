import Link from "next/link";
import { PRODUCT_NAME, NO_PHI_NOTICE } from "@/config/brand";

// Placeholder landing page for the Phase 1 toolchain smoke test. Replaced by the real shell in slice 5.
export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-6 px-6 py-16">
      <p className="text-sm font-medium uppercase tracking-widest text-ink-muted">Under construction</p>
      <h1 className="font-serif text-5xl font-light italic text-ink">{PRODUCT_NAME}</h1>
      <p className="text-lg text-ink-body">
        Send, sign and verify business documents. This build is a development preview: nothing here is
        ready for real documents yet.
      </p>
      <p className="rounded-md border border-hairline bg-surface-sand p-4 text-sm text-ink-body">{NO_PHI_NOTICE}</p>
      <div className="flex flex-wrap gap-3">
        <Link href="/login" className="inline-flex min-h-11 items-center rounded-pill bg-ink px-6 text-base text-on-ink no-underline">
          Sign in
        </Link>
        <Link href="/signup" className="inline-flex min-h-11 items-center rounded-pill border border-control-border px-6 text-base text-ink no-underline">
          Create an account
        </Link>
      </div>
    </main>
  );
}
