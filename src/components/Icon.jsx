export function Icon({ paths, color, size }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.3} strokeLinecap="round" strokeLinejoin="round" style={{ flex: "0 0 auto" }}>
      {paths.map((d, i) => <path d={d} key={i} />)}
    </svg>
  );
}
