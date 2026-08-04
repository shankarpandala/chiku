// Chiku the elephant calf — layered flat vector, every state a discrete
// swappable layer (mouth is driven by TTS timing marks in the real product).
// Props: emote, viseme, showBody, ring, bars, crop.

const MOUTHS = {
  closed: "M102 174 Q124 187 146 174 Q124 181 102 174 Z",
  A: "M105 166 Q124 157 143 166 Q138 196 124 196 Q110 196 105 166 Z",
  E: "M103 169 Q124 163 145 169 Q135 186 124 186 Q113 186 103 169 Z",
  O: "M124 160 C136 160 143 169 143 179 C143 190 136 198 124 198 C112 198 105 190 105 179 C105 169 112 160 124 160 Z",
  U: "M124 163 C133 163 139 171 139 180 C139 190 132 197 124 197 C116 197 109 190 109 180 C109 171 115 163 124 163 Z",
  F: "M103 174 Q124 167 145 174 Q124 186 103 174 Z",
  L: "M105 166 Q124 157 143 166 Q138 194 124 194 Q110 194 105 166 Z",
  smile: "M100 168 Q124 203 148 168 Q124 180 100 168 Z",
};

const TRUNKS = {
  down: ["M110 122 C104 140 96 154 84 162", "M84 162 C72 170 58 170 50 162", "M50 162 C43 155 44 145 51 141"],
  wave: ["M110 122 C104 138 98 150 88 156", "M88 156 C76 160 62 154 58 142", "M58 142 C56 130 62 122 70 122"],
  lift: ["M110 122 C104 138 98 150 88 156", "M88 156 C76 160 64 156 60 146", "M60 146 C58 138 62 132 68 131"],
};

export default function ChikuFace(props) {
  const emote = props.emote || "idle";
  const showBody = props.showBody ?? false;
  const listening = emote === "listening";
  const happy = emote === "happy";
  const goodbye = emote === "goodbye";
  const thinking = emote === "thinking";
  const encouraging = emote === "encouraging";

  let viseme = props.viseme || (happy || goodbye ? "smile" : "closed");
  if (thinking && !props.viseme) viseme = "U";

  const eyesHappy = happy || goodbye;
  const look = thinking ? 1 : 0;
  const trunk = goodbye ? TRUNKS.wave : (encouraging || thinking) ? TRUNKS.lift : TRUNKS.down;

  const box = props.crop === "head" ? "8 6 224 212" : (showBody ? "0 0 240 356" : "0 0 240 248");
  const ring = props.ring ?? listening;
  const bars = props.bars ?? listening;
  const tilt = listening ? "rotate(-5)" : encouraging ? "rotate(3)" : goodbye ? "rotate(-4)" : "rotate(0)";
  const earL = listening ? "rotate(-14) scale(1.08)" : goodbye ? "rotate(-8)" : "rotate(0)";
  const earR = listening ? "rotate(5)" : happy ? "rotate(9)" : "rotate(0)";
  const eyeR = listening ? 19 : 17;
  const pupilY = 96 + (look ? -5 : 2);
  const pupilLX = 88 + (look ? 6 : 2);
  const pupilRX = 156 + (look ? 6 : 2);
  const glintY = 90 + (look ? -5 : 0);
  const glintLX = 82 + (look ? 6 : 0);
  const glintRX = 150 + (look ? 6 : 0);
  const browL = listening ? "M74 62 Q88 52 102 58" : encouraging ? "M74 64 Q88 52 102 60" : thinking ? "M74 66 Q88 54 102 62" : "M76 66 Q88 60 100 64";
  const browR = listening ? "M142 58 Q156 52 170 62" : encouraging ? "M142 60 Q156 56 170 66" : thinking ? "M142 56 Q156 48 170 58" : "M144 64 Q156 60 168 66";
  const mouthPath = MOUTHS[viseme] || MOUTHS.closed;
  const tongue = viseme === "L";
  const blush = happy || encouraging;
  const [t1, t2, t3] = trunk;

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
      <svg viewBox={box} style={{ width: "100%", height: "100%", maxHeight: "100vh", overflow: "visible", display: "block" }} aria-hidden="true">
        {ring && (
          <g>
            <circle cx="120" cy="112" r="128" fill="none" stroke="#2f8f86" strokeWidth="4" strokeDasharray="14 12" style={{ animation: "chikuSpin 9s linear infinite", transformOrigin: "120px 112px" }} />
            <circle cx="120" cy="112" r="112" fill="none" stroke="#2f8f86" strokeWidth="9" opacity=".26" style={{ animation: "chikuRing 1.6s ease-in-out infinite", transformOrigin: "120px 112px" }} />
          </g>
        )}

        <g transform={tilt} style={{ transformOrigin: "120px 170px" }}>
          {showBody && (
            <g>
              <rect x="82" y="290" width="30" height="48" rx="15" fill="#8b7ab0" />
              <rect x="128" y="290" width="30" height="48" rx="15" fill="#8b7ab0" />
              <ellipse cx="97" cy="338" rx="19" ry="11" fill="#cdc3e4" />
              <ellipse cx="143" cy="338" rx="19" ry="11" fill="#cdc3e4" />
              <ellipse cx="120" cy="252" rx="68" ry="64" fill="#a293c4" />
              <ellipse cx="120" cy="268" rx="41" ry="40" fill="#cdc3e4" />
            </g>
          )}

          <g transform={earL} style={{ transformOrigin: "76px 104px" }}>
            <ellipse cx="34" cy="98" rx="46" ry="53" fill="#8b7ab0" />
            <ellipse cx="24" cy="99" rx="25" ry="31" fill="#e9b6b4" />
          </g>
          <g transform={earR} style={{ transformOrigin: "164px 104px" }}>
            <ellipse cx="206" cy="98" rx="46" ry="53" fill="#8b7ab0" />
            <ellipse cx="216" cy="99" rx="25" ry="31" fill="#e9b6b4" />
          </g>

          <path d="M120 28 C182 28 198 66 198 110 C198 164 166 200 120 200 C74 200 42 164 42 110 C42 66 58 28 120 28 Z" fill="#a293c4" />
          <path d="M100 31 C97 19 105 11 113 15" fill="none" stroke="#8b7ab0" strokeWidth="7" strokeLinecap="round" />
          <path d="M118 28 C120 16 130 10 136 16" fill="none" stroke="#8b7ab0" strokeWidth="7" strokeLinecap="round" />

          {blush && (
            <g opacity=".5">
              <ellipse cx="66" cy="142" rx="17" ry="9" fill="#e9848c" />
              <ellipse cx="178" cy="142" rx="17" ry="9" fill="#e9848c" />
            </g>
          )}

          {!eyesHappy && (
            <g style={{ animation: "chikuBlink 5.2s ease-in-out infinite", transformOrigin: "120px 96px" }}>
              <ellipse cx="88" cy="96" rx={eyeR} ry={eyeR} fill="#fdf6ec" />
              <ellipse cx="156" cy="96" rx={eyeR} ry={eyeR} fill="#fdf6ec" />
              <circle cx={pupilLX} cy={pupilY} r="10" fill="#2c2a35" />
              <circle cx={pupilRX} cy={pupilY} r="10" fill="#2c2a35" />
              <circle cx={glintLX} cy={glintY} r="3.6" fill="#fdf6ec" />
              <circle cx={glintRX} cy={glintY} r="3.6" fill="#fdf6ec" />
            </g>
          )}
          {eyesHappy && (
            <g fill="none" stroke="#2c2a35" strokeWidth="7" strokeLinecap="round">
              <path d="M75 100 Q88 84 101 100" />
              <path d="M143 100 Q156 84 169 100" />
            </g>
          )}

          <g fill="none" stroke="#2c2a35" strokeWidth="6" strokeLinecap="round" opacity=".9">
            <path d={browL} />
            <path d={browR} />
          </g>

          <g transform="translate(4,0)">
            <path d={mouthPath} fill="#2c2a35" />
            {tongue && <ellipse cx="124" cy="184" rx="13" ry="9" fill="#e9848c" />}
          </g>

          <g>
            <path d={t3} fill="none" stroke="#7d6da3" strokeWidth="27" strokeLinecap="round" />
            <path d={t2} fill="none" stroke="#7d6da3" strokeWidth="37" strokeLinecap="round" />
            <path d={t1} fill="none" stroke="#7d6da3" strokeWidth="47" strokeLinecap="round" />
            <path d={t3} fill="none" stroke="#a698ca" strokeWidth="21" strokeLinecap="round" />
            <path d={t2} fill="none" stroke="#a698ca" strokeWidth="31" strokeLinecap="round" />
            <path d={t1} fill="none" stroke="#a698ca" strokeWidth="41" strokeLinecap="round" />
            <path d={t1} fill="none" stroke="#7d6da3" strokeWidth="41" strokeLinecap="butt" opacity=".2" strokeDasharray="3 15" strokeDashoffset="16" />
          </g>
        </g>
      </svg>

      {bars && (
        <div style={{ position: "absolute", bottom: "-4%", left: "50%", transform: "translateX(-50%)", display: "flex", gap: 7, alignItems: "flex-end", height: 40 }}>
          {[0, 0.15, 0.3, 0.45, 0.6].map((d) => (
            <div key={d} style={{ width: 9, height: "100%", background: "#2f8f86", borderRadius: 5, animation: "chikuBar .9s ease-in-out " + d + "s infinite" }} />
          ))}
        </div>
      )}
    </div>
  );
}
