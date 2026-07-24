"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Static export can't server-redirect (#208), so the root path — kept for the
// sidebar's href="/" — redirects on the client.
export default function Home() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/inbox");
  }, [router]);
  return null;
}
