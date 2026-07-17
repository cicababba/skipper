import { Github, KeyRound } from "lucide-react";
import type { AuthProviderId } from "@skipper/shared";

export type ProviderIcon = (props: { size?: number; className?: string }) => React.ReactNode;

export const PROVIDER_ICONS: Partial<Record<AuthProviderId, ProviderIcon>> = {
  google: GoogleMark,
  github: Github,
  gitlab: GitLabMark,
  jira: JiraMark,
};

export const FALLBACK_PROVIDER_ICON: ProviderIcon = KeyRound;

function GoogleMark({ size = 14 }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden>
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.49h4.84a4.14 4.14 0 0 1-1.79 2.72v2.26h2.9c1.69-1.56 2.66-3.86 2.66-6.63z"/>
      <path fill="#34A853" d="M9 18c2.43 0 4.46-.81 5.94-2.18l-2.9-2.26c-.81.55-1.84.87-3.04.87-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A8.99 8.99 0 0 0 9 18z"/>
      <path fill="#FBBC05" d="M3.97 10.73a5.42 5.42 0 0 1 0-3.46V4.94H.96a9 9 0 0 0 0 8.13l3.01-2.34z"/>
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.34l2.58-2.58A8.99 8.99 0 0 0 9 0 9 9 0 0 0 .96 4.94l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/>
    </svg>
  );
}

function GitLabMark({ size = 14 }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path
        fill="#FC6D26"
        d="M12 21.42l3.684-11.333H8.316L12 21.42zM3.16 10.087L2.043 13.53a.762.762 0 0 0 .277.852L12 21.42 3.16 10.087zm5.156 0H3.16l1.905-5.863a.39.39 0 0 1 .742 0l2.509 5.863zM20.84 10.087l1.117 3.442a.762.762 0 0 1-.277.852L12 21.42l8.84-11.333zm-5.156 0h5.156l-1.905-5.863a.39.39 0 0 0-.742 0l-2.509 5.863z"
      />
    </svg>
  );
}

function JiraMark({ size = 14 }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path
        fill="#2684FF"
        d="M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005z"
      />
      <path
        fill="#2684FF"
        d="M17.317 5.756H5.746a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.232 5.215V6.76a1.005 1.005 0 0 0-1.005-1.005z"
      />
      <path
        fill="#2684FF"
        d="M23.063 0H11.492a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.168 5.215V1.005A1.005 1.005 0 0 0 23.063 0z"
      />
    </svg>
  );
}
