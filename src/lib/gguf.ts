/** GGUF v2/v3 header inspection. Never reads model tensors or an entire model. */
export type GgufMetadata = {
  architecture?: string;
  quantization?: string;
  parameters?: number;
  contextLength?: number;
};

const MAX_HEADER = 16 * 1024 * 1024;
const QUANTS: Record<number, string> = {
  0: "F32",
  1: "F16",
  2: "Q4_0",
  3: "Q4_1",
  7: "Q8_0",
  8: "Q5_0",
  9: "Q5_1",
  10: "Q2_K",
  11: "Q3_K_S",
  12: "Q3_K_M",
  13: "Q3_K_L",
  14: "Q4_K_S",
  15: "Q4_K_M",
  16: "Q5_K_S",
  17: "Q5_K_M",
  18: "Q6_K",
  19: "IQ2_XXS",
  20: "IQ2_XS",
  21: "Q2_K_S",
  22: "IQ3_XS",
  23: "IQ3_XXS",
  24: "IQ1_S",
  25: "IQ4_NL",
  26: "IQ3_S",
  27: "IQ3_M",
  28: "IQ2_S",
  29: "IQ2_M",
  30: "IQ4_XS",
  31: "IQ1_M",
  32: "BF16",
  36: "TQ1_0",
  37: "TQ2_0",
  38: "MXFP4",
  39: "NVFP4",
  40: "Q1_0",
  41: "Q2_0",
};

export async function readGgufMetadata(file: Blob): Promise<GgufMetadata> {
  const view = new DataView(await file.slice(0, MAX_HEADER).arrayBuffer());
  let pos = 0;
  const check = (size: number) => {
    if (!Number.isSafeInteger(size) || size < 0 || pos + size > view.byteLength)
      throw new Error("GGUF metadata is truncated or exceeds the 16 MiB inspection limit.");
  };
  const u32 = () => {
    check(4);
    const n = view.getUint32(pos, true);
    pos += 4;
    return n;
  };
  const u64 = () => {
    check(8);
    const n = Number(view.getBigUint64(pos, true));
    pos += 8;
    if (!Number.isSafeInteger(n)) throw new Error("GGUF metadata contains an unsafe length.");
    return n;
  };
  const string = (keep = true) => {
    const length = u64();
    check(length);
    const result = keep ? new TextDecoder().decode(new Uint8Array(view.buffer, pos, length)) : "";
    pos += length;
    return result;
  };
  const value = (type: number, keep: boolean): string | number | undefined => {
    if (type === 8) return string(keep);
    if (type === 9) {
      const subtype = u32(),
        count = u64();
      if (count > 1_000_000 || subtype === 9) throw new Error("Unsupported GGUF metadata array.");
      for (let i = 0; i < count; i++) value(subtype, false);
      return;
    }
    const lengths: Record<number, number> = {
      0: 1,
      1: 1,
      2: 2,
      3: 2,
      4: 4,
      5: 4,
      6: 4,
      7: 1,
      10: 8,
      11: 8,
      12: 8,
    };
    const size = lengths[type];
    if (!size) throw new Error(`Unsupported GGUF metadata type ${type}.`);
    check(size);
    let n: number | undefined;
    if (keep) {
      switch (type) {
        case 0:
        case 7:
          n = view.getUint8(pos);
          break;
        case 1:
          n = view.getInt8(pos);
          break;
        case 2:
          n = view.getUint16(pos, true);
          break;
        case 3:
          n = view.getInt16(pos, true);
          break;
        case 4:
          n = view.getUint32(pos, true);
          break;
        case 5:
          n = view.getInt32(pos, true);
          break;
        case 6:
          n = view.getFloat32(pos, true);
          break;
        case 10:
          n = Number(view.getBigUint64(pos, true));
          break;
        case 11:
          n = Number(view.getBigInt64(pos, true));
          break;
        case 12:
          n = view.getFloat64(pos, true);
          break;
      }
    }
    pos += size;
    return n;
  };
  if (u32() !== 0x46554747) throw new Error("This file is not a GGUF model.");
  const version = u32();
  if (version !== 2 && version !== 3)
    throw new Error(`GGUF version ${version} is unsupported; use a v2 or v3 model.`);
  u64(); // Tensor count; tensor data is deliberately not read.
  const count = u64();
  if (count > 100_000) throw new Error("GGUF metadata has too many entries.");
  const result: GgufMetadata = {};
  for (let i = 0; i < count; i++) {
    const key = string();
    const selected =
      key === "general.architecture" ||
      key === "general.file_type" ||
      key === "general.parameter_count" ||
      key.endsWith(".context_length");
    const item = value(u32(), selected);
    if (key === "general.architecture" && typeof item === "string") result.architecture = item;
    if (key === "general.file_type" && typeof item === "number")
      result.quantization = QUANTS[item] ?? `Type ${item}`;
    if (
      key === "general.parameter_count" &&
      typeof item === "number" &&
      Number.isSafeInteger(item) &&
      item > 0
    )
      result.parameters = item;
    if (key.endsWith(".context_length") && typeof item === "number" && item > 0)
      result.contextLength = item;
  }
  return result;
}
