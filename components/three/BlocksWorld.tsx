// components/three/BlocksWorld.tsx
// Live scene with per-chain colors from props.
// - InstancedMesh cubes; height ~ amountUsd, color ~ chain.
// - Hover highlight brightens the hovered block.

"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, StatsGl } from "@react-three/drei";
import * as THREE from "three";
import { useEffect, useMemo, useRef, useState } from "react";

type Datum = {
  id: string;
  amountUsd: number;
  chain: string;
};

type Props = {
  data: Datum[];
  colorMap?: Record<string, string>;
};

const GRID_COLS = 40;
const CELL = 1.15;
const BASE_HEIGHT = 0.2;
const MAX_SCALE = 2.2;

const DEFAULT_COLOR = new THREE.Color("#4ad6ff"); // fallback when chain not mapped

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

function InstancedBlocks({ data, colorMap }: { data: Datum[]; colorMap?: Record<string, string> }) {
  const meshRef = useRef<THREE.InstancedMesh>(null!);
  const tempObj = useMemo(() => new THREE.Object3D(), []);
  const tempColor = useMemo(() => new THREE.Color(), []);
  const [hovered, setHovered] = useState<number | null>(null);

  const maxUsd = useMemo(() => Math.max(...data.map((d) => d.amountUsd), 1), [data]);

  // Precompute per-instance base colors
  const baseColors = useMemo(() => {
    return data.map((d, i) => {
      const base = colorForChain(d.chain, colorMap);
      const mod = 0.9 + 0.1 * ((i % GRID_COLS) / GRID_COLS);
      return base.multiplyScalar(mod);
    });
  }, [data, colorMap]);

  // Grid positions & base scales
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
  }, [data, maxUsd]);

  // Initialize matrices & colors
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

  // Subtle idle animation (breathe)
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

  // Hover highlight
  const onPointerMove = (e: any) => {
    e.stopPropagation();
    const instanceId = e.instanceId as number | undefined;
    if (instanceId === undefined || instanceId === hovered) return;

    setHovered(instanceId);
    const m = meshRef.current;
    for (let i = 0; i < positions.length; i++) {
      const c = i === instanceId ? baseColors[i].clone().multiplyScalar(1.35) : baseColors[i];
      tempColor.copy(c);
      m.setColorAt(i, tempColor);
    }
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  };

  const onPointerOut = () => {
    setHovered(null);
    const m = meshRef.current;
    for (let i = 0; i < positions.length; i++) {
      m.setColorAt(i, baseColors[i]);
    }
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  };

  return (
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
  );
}

export default function BlocksWorld({ data, colorMap }: Props) {
  return (
    <Canvas
      dpr={[1, 2]}
      camera={{ position: [0, 30, 36], fov: 55, near: 0.1, far: 1000 }}
      gl={{ antialias: true, powerPreference: "high-performance" }}
    >
      {/* Lighting */}
      <hemisphereLight intensity={0.7} color={"#ffffff"} groundColor={"#0a0a0a"} />
      <directionalLight position={[8, 12, 5]} intensity={1.2} />

      {/* Ground plane */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[200, 200]} />
        <meshStandardMaterial color={"#0b0b0b"} metalness={0} roughness={1} />
      </mesh>

      {/* Instanced grid */}
      <InstancedBlocks data={data} colorMap={colorMap} />

      {/* Controls / Stats */}
      <OrbitControls enablePan enableZoom enableRotate />
      <StatsGl className="hidden md:block" />
    </Canvas>
  );
}

