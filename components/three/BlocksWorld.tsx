// components/three/BlocksWorld.tsx
// Tooltip anchored in 3D with a 2s linger after pointer leaves.

"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { Html, OrbitControls, StatsGl } from "@react-three/drei";
import * as THREE from "three";
import { useEffect, useMemo, useRef, useState } from "react";

export type SceneDatum = {
  id: string;
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
const DEFAULT_COLOR = new THREE.Color("#4b5563");

function normalizeAmount(value: number, maxValue: number) {
  if (!maxValue) return 1;
  const n = value / maxValue;
  return BASE_HEIGHT + Math.pow(n, 0.5) * (MAX_SCALE - BASE_HEIGHT);
}
function colorForChain(chain: string, colorMap?: Record<string, string>): THREE.Color {
  const key = (chain || "").toLowerCase();
  const hex = colorMap?.[key];
  return hex ? new THREE.Color(hex) : DEFAULT_COLOR.clone();
}
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

function InstancedBlocks({ data, colorMap }: { data: SceneDatum[]; colorMap?: Record<string, string> }) {
  const meshRef = useRef<THREE.InstancedMesh>(null!);
  const tempObj = useMemo(() => new THREE.Object3D(), []);
  const tempColor = useMemo(() => new THREE.Color(), []);
  const [hovered, setHovered] = useState<number | null>(null);
  const [linger, setLinger] = useState<number | null>(null); // index that lingers
  const lingerTimeout = useRef<NodeJS.Timeout | null>(null);

  const GRID_COLS = useMemo(() => Math.max(3, Math.ceil(Math.sqrt(data.length))), [data.length]);
  const maxUsd = useMemo(() => Math.max(...data.map((d) => d.amountUsd), 1), [data]);
  const baseColors = useMemo(() => data.map((d) => colorForChain(d.chain, colorMap)), [data, colorMap]);

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

  // init matrices & colors
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

  // idle animation
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
    setLinger(instanceId);
    if (lingerTimeout.current) clearTimeout(lingerTimeout.current);
    applyHover(instanceId);
  };

  const onPointerOut = () => {
    setHovered(null);
    if (lingerTimeout.current) clearTimeout(lingerTimeout.current);
    // keep last hovered visible for 2s
    lingerTimeout.current = setTimeout(() => setLinger(null), 2000);
  };

  const activeId = hovered !== null ? hovered : linger;
  const activeDatum = activeId !== null ? data[activeId] : null;
  const tooltipPos =
    activeId !== null ? new THREE.Vector3(positions[activeId].x, scales[activeId] + 0.6, positions[activeId].z) : null;

  return (
    <>
      <instancedMesh
        ref={meshRef}
        args={[undefined as any, undefined as any, data.length]}
        onPointerMove={onPointerMove}
        onPointerOut={onPointerOut}
      >
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial toneMapped />
      </instancedMesh>

      {activeDatum && tooltipPos && (
        <Html position={tooltipPos} transform occlude distanceFactor={8} pointerEvents="auto">
          <div className="rounded-lg border border-gray-300 bg-white/95 p-2 text-xs shadow-md">
            <div className="mb-1 flex items-center gap-2">
              <span
                className="inline-block h-2.5 w-2.5 rounded-full border border-black/10"
                style={{ backgroundColor: colorForChain(activeDatum.chain, colorMap).getStyle() }}
              />
              <strong className="uppercase tracking-wide">{activeDatum.chain}</strong>
            </div>
            <div className="mb-1">
              USD: {activeDatum.amountUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </div>
            <div className="break-all">
              TX:&nbsp;
              {(() => {
                const url = explorerUrl(activeDatum.chain, activeDatum.id);
                const short =
                  activeDatum.id.length > 16
                    ? `${activeDatum.id.slice(0, 10)}…${activeDatum.id.slice(-6)}`
                    : activeDatum.id;
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
  const camZ = useMemo(() => {
    const n = Math.max(1, data.length);
    return Math.min(36, 14 + Math.sqrt(n) * 1.2);
  }, [data.length]);

  return (
    <Canvas
      dpr={[1, 2]}
      camera={{ position: [0, 18, camZ], fov: 55 }}
      gl={{ antialias: true, powerPreference: "high-performance" }}
    >
      <hemisphereLight intensity={0.6} color={"#ffffff"} groundColor={"#e5e7eb"} />
      <directionalLight position={[8, 12, 5]} intensity={0.9} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[200, 200]} />
        <meshStandardMaterial color={"#f8fafc"} />
      </mesh>
      <InstancedBlocks data={data} colorMap={colorMap} />
      <OrbitControls enablePan enableZoom enableRotate />
      <StatsGl className="hidden md:block" />
    </Canvas>
  );
}

