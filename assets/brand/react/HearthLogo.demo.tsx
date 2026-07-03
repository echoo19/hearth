import HearthLogo from './HearthLogo';

export default function HearthLogoDemo() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 32,
        alignItems: 'center',
        padding: 48,
        background: '#141019',
        borderRadius: 16,
        color: '#efe9f5',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      {/* Hero: ember gradient on hearthstone dark */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <HearthLogo variant="ember" size={72} />
        <span style={{ fontSize: 40, fontWeight: 600, letterSpacing: '0.01em' }}>Hearth</span>
      </div>

      {/* Mono (currentColor) inherits any text color */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
        <span style={{ color: '#f76b15' }}>
          <HearthLogo size={40} />
        </span>
        <span style={{ color: '#8d8399' }}>
          <HearthLogo size={40} />
        </span>
        <span
          style={{
            background: '#f4f1ec',
            color: '#1c1017',
            padding: 12,
            borderRadius: 10,
            display: 'inline-flex',
          }}
        >
          <HearthLogo size={40} />
        </span>
      </div>

      {/* Scale check: crisp down to favicon size */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 20, color: '#f76b15' }}>
        <HearthLogo size={64} />
        <HearthLogo size={32} />
        <HearthLogo size={24} />
        <HearthLogo size={16} />
      </div>
    </div>
  );
}
