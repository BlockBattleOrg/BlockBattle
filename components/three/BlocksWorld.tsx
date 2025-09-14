// components/three/BlocksWorld.tsx
// Auto-fit grid, white background, exact count, per-chain colors.
// Tooltip is 3D-anchored to the hovered block via <Html />, clickable link to explorer.

"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { Html, OrbitControls, StatsGl } from "@react-three/drei";
import * as THREE from "three";
import { useEffect, useMemo, useRef, useState } from "react";

export type SceneDatum = {
  id: string;         // tx hash
  amountUsd: number;
  chain: string;
};

type Props = {
  data: SceneDatum[];
  colorMap?: Record<string, string>;
};

const CELL = 1.15;
const BASE_HEIGHT = 0.2;
const MAX_SCALE = 2.2;

const DEFAULT_COLOR = new THREE.Color("#4b5563"); // neutral gray fallback

function normalizeAmount(value: number, maxValue: number) {
  if (!maxValue) return 1;
  const n = value / maxValue;
  return BASE_HEIGHT + Math.pow(n, 0.5) * (MAX_SCALE - BASE_HEIGHT);
}

function colorForChain(chain: string, colorMap?: Record<string, string>): THREE.Color {
  const key = (chain || "").toLowerCase();
  const hex = colorMap?.[key];
  if (hex) return new THREE.Color(hex);
  return DEFAULT_COLOR.clone();
}

// Minimal explorer mapping for clickable link in tooltip
function explorerUrl(chain: string, tx: string): string | null {
  const c = chain.toLowerCase();
  const map: Record<string, string> = {
    eth: "https://etherscan.io/tx/",
    pol: "https://polygonscan.com/tx/",
    op: "https://optimistic.etherscan.io/tx/",
    arb: "https://arbiscan.io/tx/",
    avax: "https://snowtrace.io/tx/",
    bsc: "https://bscscan.com/tx/",
    btc: "https://mempool.space/tx/",
    ltc: "https://blockchair.com/litecoin/transaction/",
    doge: "https://blockchair.com/dogecoin/transaction/",
    xrp: "https://xrpscan.com/tx/",
    sol: "https://solscan.io/tx/",
    xlm: "https://stellar.expert/explorer/public/tx/",
    trx: "https://tronscan.org/#/transaction/",
  };
  return map[c] ? `${map[c]}${tx}` : null;
}

function InstancedBlocks({
  data,
  colorMap,
}: {
  data: SceneDatum[];
  colorMap?: Record<string, string>;
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null!);
  const tempObj = useMemo(() => new THREE.Object3D(), []);
  const tempColor = useMemo(() => new THREE.Color(), []);
  const [hovered, setHovered] = useState<number | null>(null);

  // Grid size based on N (square-ish)
  const GRID_COLS = useMemo(() => Math.max(3, Math.ceil(Math.sqrt(data.length))), [data.length]);
  const maxUsd = useMemo(() => Math.max(...data.map((d) => d.amountUsd), 1), [data]);

  // Precompute colors
  const baseColors = useMemo(
    () => data.map((d) => colorForChain(d.chain, colorMap)),
    [data, colorMap]
  );

  // Positions & scales
  const { positions, scales } = useMemo(() => {
    const pos: THREE.Vector3[] = [];
    const sc: number[] = [];
    const rows = Math.ceil(data.length / GRID_COLS);
    const xOffset = -((GRID_COLS - 1) * CELL) / 2;
    const zOffset = -((rows - 1) * CELL) / 2;

    for (let i = 0; i < data.length; i++) {
      const col = i % GRID_COLS;
      const row = Math.floor(i / GRID_COLS);
      pos.push(new THREE.Vector3(xOffset + col * CELL, 0, zOffset + row * CELL));
      sc.push(normalizeAmount(data[i].amountUsd, maxUsd));
    }
    return { positions: pos, scales: sc };
  }, [data, maxUsd, GRID_COLS]);

  // Init matrices & colors
  useEffect(() => {
    const m = meshRef.current;
    for (let i = 0; i < positions.length; i++) {
      const s = scales[i];
      tempObj.position.set(positions[i].x, s / 2, positions[i].z);
      tempObj.scale.set(1, s, 1);
      tempObj.updateMatrix();
      m.setMatrixAt(i, tempObj.matrix);
      m.setColorAt(i, baseColors[i]);
    }
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [positions, scales, baseColors, tempObj]);

  // Idle animation
  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    const m = meshRef.current;
    for (let i = 0; i < positions.length; i++) {
      const s0 = scales[i];
      const pulse = 1 + 0.03 * Math.sin(t * 1.2 + i * 0.15);
      const s = s0 * pulse;
      tempObj.position.set(positions[i].x, s / 2, positions[i].z);
      tempObj.scale.set(1, s, 1);
      tempObj.updateMatrix();
      m.setMatrixAt(i, tempObj.matrix);
    }
    m.instanceMatrix.needsUpdate = true;
  });

  // Hover highlight + index
  const applyHover = (instanceId: number | null) => {
    const m = meshRef.current;
    for (let i = 0; i < positions.length; i++) {
      const c =
        instanceId !== null && i === instanceId
          ? baseColors[i].clone().lerp(new THREE.Color("#000000"), -0.35)
          : baseColors[i];
      tempColor.copy(c);
      m.setColorAt(i, tempColor);
    }
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  };

  const onPointerMove = (e: any) => {
    e.stopPropagation();
    const instanceId = e.instanceId as number | undefined;
    if (instanceId === undefined || instanceId === hovered) return;
    setHovered(instanceId);
    applyHover(instanceId);
  };

  const onPointerOut = () => {
    setHovered(null);
    applyHover(null);
  };

  // Tooltip content for hovered instance
  const hoveredDatum = hovered !== null ? data[hovered] : null;
  const tooltipPos =
    hovered !== null
      ? new THREE.Vector3(positions[hovered].x, scales[hovered] + 0.6, positions[hovered].z)
      : null;

  return (
    <>
      <instancedMesh
        ref={meshRef}
        args={[undefined as any, undefined as any, data.length]}
        onPointerMove={onPointerMove}
        onPointerOut={onPointerOut}
        castShadow={false}
        receiveShadow={false}
      >
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial toneMapped />
      </instancedMesh>

      {/* 3D-anchored tooltip. `occlude` hides it when blocked by other geometry; pointer events enabled. */}
      {hoveredDatum && tooltipPos && (
        <Html
          position={tooltipPos}
          transform
          occlude
          distanceFactor={8}   // scales with camera distance for readability
          pointerEvents="auto" // allow clicking the link
          style={{ willChange: "transform" }}
        >
          <div className="rounded-lg border border-gray-300 bg-white/95 p-2 text-xs shadow-md">
            <div className="mb-1 flex items-center gap-2">
              <span
                className="inline-block h-2.5 w-2.5 rounded-full border border-black/10"
                style={{ backgroundColor: colorForChain(hoveredDatum.chain, colorMap).getStyle() }}
              />
              <strong className="uppercase tracking-wide">{hoveredDatum.chain}</strong>
            </div>
            <div className="mb-1">USD: {hoveredDatum.amountUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
            <div className="break-all">
              TX:&nbsp;
              {(() => {
                const url = explorerUrl(hoveredDatum.chain, hoveredDatum.id);
                const short = hoveredDatum.id.length > 16
                  ? `${hoveredDatum.id.slice(0, 10)}…${hoveredDatum.id.slice(-6)}`
                  : hoveredDatum.id;
                return url ? (
                  <a className="text-blue-600 underline" href={url} target="_blank" rel="noreferrer">
                    {short}
                  </a>
                ) : (
                  short
                );
              })()}
            </div>
          </div>
        </Html>
      )}
    </>
  );
}

export default function BlocksWorld({ data, colorMap }: Props) {
  // Camera distance scales with N
  const camZ = useMemo(() => {
    const n = Math.max(1, data.length);
    return Math.min(36, 14 + Math.sqrt(n) * 1.2);
  }, [data.length]);

  return (
    <Canvas
      dpr={[1, 2]}
      camera={{ position: [0, 18, camZ], fov: 55, near: 0.1, far: 1000 }}
      gl={{ antialias: true, powerPreference: "high-performance" }}
    >
      {/* Lighting for white bg */}
      <hemisphereLight intensity={0.6} color={"#ffffff"} groundColor={"#e5e7eb"} />
      <directionalLight position={[8, 12, 5]} intensity={0.9} />

      {/* Ground */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[200, 200]} />
        <meshStandardMaterial color={"#f8fafc"} metalness={0} roughness={1} />
      </mesh>

      <InstancedBlocks data={data} colorMap={colorMap} />

      <OrbitControls enablePan enableZoom enableRotate />
      <StatsGl className="hidden md:block" />
    </Canvas>
  );
}

