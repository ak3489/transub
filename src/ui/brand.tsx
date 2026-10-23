export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient
          id="transub-logo-gradient"
          x1="4"
          y1="3"
          x2="28"
          y2="29"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#BDF9E9" />
          <stop offset="0.55" stopColor="#74E4CB" />
          <stop offset="1" stopColor="#3CBFA3" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9.5" fill="url(#transub-logo-gradient)" />
      <path
        d="M7.5 11.5h17"
        stroke="#04120E"
        strokeWidth="2.6"
        strokeLinecap="round"
        opacity=".92"
      />
      <path
        d="M12 16.6h12.5"
        stroke="#04120E"
        strokeWidth="2.6"
        strokeLinecap="round"
        opacity=".5"
      />
      <path
        d="M7.5 21.7h9"
        stroke="#04120E"
        strokeWidth="2.6"
        strokeLinecap="round"
        opacity=".82"
      />
    </svg>
  );
}
