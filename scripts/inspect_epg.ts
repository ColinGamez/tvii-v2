import { readFileSync } from "fs";
import { gunzipSync } from "zlib";

function inspect(path: string, label: string) {
  const buf = readFileSync(path);
  const xml = gunzipSync(buf).toString("utf-8");
  const channels = xml.match(/<channel\s+id="([^"]*)"/g) || [];
  const channelIds = channels.map(c => {
    const m = c.match(/id="([^"]*)"/);
    return m ? m[1] : "???";
  });
  const progs = xml.match(/<programme\s/g) || [];
  
  console.log(`\n=== ${label} ===`);
  console.log(`Total chars: ${xml.length}`);
  console.log(`Channels: ${channelIds.length}`);
  console.log(`Programmes: ${progs.length}`);
  
  // Show all channel IDs
  console.log(`\nAll channel IDs:`);
  channelIds.forEach((id, i) => console.log(`  ${i+1}. ${id}`));
  
  // Show first 3 programme blocks
  const progBlocks = xml.match(/<programme[\s\S]*?<\/programme>/g) || [];
  console.log(`\nFirst 3 programmes:`);
  progBlocks.slice(0, 3).forEach((p, i) => {
    console.log(`\n--- Programme ${i+1} ---`);
    console.log(p.substring(0, 500));
  });
  
  // Check date ranges
  const starts = xml.match(/start="(\d{14})/g) || [];
  if (starts.length > 0) {
    const times = starts.map(s => s.replace('start="', ''));
    times.sort();
    console.log(`\nDate range: ${times[0]} to ${times[times.length - 1]}`);
  }
  
  // Check overlap — unique channel IDs
  return { channelIds: new Set(channelIds), progCount: progs.length };
}

const r1 = inspect("epg_ripper_JP1.xml.gz", "JP1");
const r2 = inspect("epg_ripper_JP2.xml.gz", "JP2");

// Check overlap
const overlap = [...r1.channelIds].filter(id => r2.channelIds.has(id));
const onlyIn1 = [...r1.channelIds].filter(id => !r2.channelIds.has(id));
const onlyIn2 = [...r2.channelIds].filter(id => !r1.channelIds.has(id));
const allChannels = new Set([...r1.channelIds, ...r2.channelIds]);

console.log("\n\n=== OVERLAP ANALYSIS ===");
console.log(`JP1 unique channels: ${r1.channelIds.size}`);
console.log(`JP2 unique channels: ${r2.channelIds.size}`);
console.log(`Shared channels: ${overlap.length}`);
console.log(`Only in JP1: ${onlyIn1.length}`);
console.log(`Only in JP2: ${onlyIn2.length}`);
console.log(`Combined unique channels: ${allChannels.size}`);
console.log(`Combined programmes: ${r1.progCount + r2.progCount}`);

if (overlap.length > 0) {
  console.log(`\nShared channel IDs:`);
  overlap.forEach(id => console.log(`  - ${id}`));
}
if (onlyIn1.length > 0) {
  console.log(`\nOnly in JP1:`);
  onlyIn1.forEach(id => console.log(`  - ${id}`));
}
if (onlyIn2.length > 0) {
  console.log(`\nOnly in JP2:`);
  onlyIn2.forEach(id => console.log(`  - ${id}`));
}
