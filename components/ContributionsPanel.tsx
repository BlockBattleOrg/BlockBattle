'use client';

import React from 'react';



function RecentContributions() {

  return (
    <div className="rounded-2xl border">
      <div className="border-b px-4 py-3 text-sm font-medium">Recent contributions</div>
      <div className="p-4 text-sm text-gray-600">… your existing recent list table goes here …</div>
    </div>
  );
}

function TotalsByChain() {
 
  return (
    <div className="rounded-2xl border">
      <div className="border-b px-4 py-3 text-sm font-medium">Totals by chain</div>
      <div className="p-4 text-sm text-gray-600">… your existing totals table goes here …</div>
    </div>
  );
}

export default function ContributionsPanel() {
  return (
    <section className="mt-10 space-y-6">
      {/* 1) Recent on top (full width) */}
      <RecentContributions />

      {/* 2) Totals below (full width) */}
      <TotalsByChain />
    </section>
  );
}

