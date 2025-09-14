// components/three/BlocksWorld.tsx
// Level 1 MVP: instanced cubes arranged in a grid, animated scale by amountUsd.
// - Uses InstancedMesh for performance (hundreds to thousands of items).
// - Basic hover highlight via raycasting.
// - OrbitControls enabled; no heavy postprocessing to keep mobile perf healthy.

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
};

const GRID_COLS = 40; // number of columns in the grid
const CELL = 1.15;    // spacing between cubes
const BASE_HEIGHT = 0.2; // minimal cube height
const MAX_SCALE = 2.2;   // max cube height scale multiplier

// Simple color palette; we can later switch to chain-based mapping.
const BASE_COLOR = new THREE.Color("#4ad6ff");
const HOVER_COLOR = new THREE.Color("#ffd54a");

function normalizeAmount(value: number, maxValue: number) {
  if (!maxValue) return 1;
  const n = value / maxValue; // 0..1
  // Ease slightly so small values are still visible
  return BASE_HEIGHT + Math.pow(n, 0.5) * (MAX_SCALE - BASE_HEIGHT);
}

function InstancedBlocks({ data }: { data: Datum[] }) {
  const meshRef = useRef<THREE.InstancedMesh>(null!);
  const tempObj = useMemo(() => new THREE.Object3D(), []);
  const color = useMemo(() => new THREE.Color(), []);
  const [hovered, setHovered] = useState<number | null>(null);

  // Precompute max for normalization
  const maxUsd = useMemo(() => Math.max(...data.map((d) => d.amountUsd), 1), [data]);

  // Build grid positions
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
      tempObj.position.set(positions[i].x, s / 2, positions[i].z); // lift by half height
      tempObj.scale.set(1, s, 1);
      tempObj.updateMatrix();
      m.setMatrixAt(i, tempObj.matrix);

      // base color (slightly modulate by row for subtle variation)
      const mod = 0.9 + 0.1 * ((i % GRID_COLS) / GRID_COLS);
      color.copy(BASE_COLOR).multiplyScalar(mod);
      m.setColorAt(i, color);
    }
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [positions, scales, color, tempObj]);

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

  // Raycast handling for hover highlight
  const onPointerMove = (e: any) => {
    e.stopPropagation();
    const instanceId = e.instanceId as number | undefined;
    if (instanceId === undefined) return;
    if (hovered !== instanceId) {
      setHovered(instanceId);
      const m = meshRef.current;
      for (let i = 0; i < positions.length; i++) {
        const mod = 0.9 + 0.1 * ((i % GRID_COLS) / GRID_COLS);
        color.copy(i === instanceId ? HOVER_COLOR : BASE_COLOR).multiplyScalar(mod);
        m.setColorAt(i, color);
      }
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  };

  const onPointerOut = () => {
    setHovered(null);
    const m = meshRef.current;
    for (let i = 0; i < positions.length; i++) {
      const mod = 0.9 + 0.1 * ((i % GRID_COLS) / GRID_COLS);
      color.copy(BASE_COLOR).multiplyScalar(mod);
      m.setColorAt(i, color);
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
      <boxGeometry args={[1, 1, 1]}>
        {/* nothing extra here */}
      </boxGeometry>
      <meshStandardMaterial toneMapped={true} />
    </instancedMesh>
  );
}

export default function BlocksWorld({ data }: Props) {
  return (
    <Canvas
      dpr={[1, 2]}
      camera={{ position: [0, 30, 36], fov: 55, near: 0.1, far: 1000 }}
      gl={{ antialias: true, powerPreference: "high-performance" }}
    >
      {/* Lighting */}
      <hemisphereLight intensity={0.7} color={"#ffffff"} groundColor={"#0a0a0a"} />
      <directionalLight position={[8, 12, 5]} intensity={1.2} />

      {/* Ground plane (very subtle) */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[200, 200]} />
        <meshStandardMaterial color={"#0b0b0b"} metalness={0} roughness={1} />
      </mesh>

      {/* Instanced grid of blocks */}
      <InstancedBlocks data={data} />

      {/* Camera controls & stats (can be removed for production) */}
      <OrbitControls enablePan={true} enableZoom={true} enableRotate={true} />
      <StatsGl className="hidden md:block" />
    </Canvas>
  );
}

