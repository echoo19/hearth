-- Value noise from scratch. ctx.math has no noise primitive, so the
-- warrens carve their tunnels with this hand-rolled lattice noise — and
-- because it lives in scripts/lib/, BOTH behaviors (cave-carver.lua,
-- crystal-grower.lua) require() the exact same field math instead of
-- copy-pasting it. That reuse is what script modules are for.
--
-- Everything here is a pure function of (x, y, seed): no ctx, no state.
-- Callers derive the lattice seed from the seeded ctx.random stream, so a
-- session seed pins the entire cave layout.
local noise = {}

-- Deterministic lattice hash -> [0, 1). Lua 5.4 integer mixing, identical
-- on every platform the wasm Lua engine runs on.
function noise.hash2(x, y, seed)
  local h = (x * 374761393 + y * 668265263 + seed * 1442695041) % 4294967296
  h = ((h ~ (h >> 13)) * 1274126177) % 4294967296
  return ((h ~ (h >> 16)) % 65536) / 65536.0
end

local function smooth(t)
  return t * t * (3.0 - 2.0 * t)
end

-- Smoothly interpolated value noise over the integer lattice, in [0, 1).
function noise.value2(x, y, seed)
  local x0 = math.floor(x)
  local y0 = math.floor(y)
  local fx = x - x0
  local fy = y - y0
  local a = noise.hash2(x0, y0, seed)
  local b = noise.hash2(x0 + 1, y0, seed)
  local c = noise.hash2(x0, y0 + 1, seed)
  local d = noise.hash2(x0 + 1, y0 + 1, seed)
  local u = smooth(fx)
  local v = smooth(fy)
  local top = a + (b - a) * u
  local bottom = c + (d - c) * u
  return top + (bottom - top) * v
end

-- Two-octave fractal value noise, still in [0, 1).
function noise.fbm2(x, y, seed)
  return (noise.value2(x, y, seed) * 2.0 + noise.value2(x * 2.0, y * 2.0, seed + 101)) / 3.0
end

-- The cave rule both behaviors share: is interior cell (col, row) open
-- tunnel for this seed? Borders are always wall; callers clamp.
function noise.caveOpen(col, row, seed)
  return noise.fbm2(col * 0.35, row * 0.35, seed) < 0.56
end

-- One integer lattice seed drawn from the seeded ctx.random stream.
function noise.seedFrom(random)
  return math.floor(random.next() * 1048576)
end

return noise
