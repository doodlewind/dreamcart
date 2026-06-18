//! A single-arena sub-allocator for QuickJS + newlib `malloc`.
//!
//! rust-psp's global allocator (`alloc_impl.rs`) calls `sceKernelAllocPartitionMemory`
//! for EVERY allocation — i.e. one kernel object per allocation. The PSP kernel
//! caps the number of objects (~4096 in PPSSPP), and QuickJS makes many thousands
//! of small allocations evaluating a large bundle, so it exhausts the slots and
//! the un-checked allocator writes to a null block head -> the `0x300000000` crash.
//!
//! Fix: grab ONE big block from the kernel up front and sub-allocate from it. Every
//! QuickJS / C `malloc` then comes from this arena and consumes ZERO additional
//! kernel objects.
//!
//! The sub-allocator is a SEGREGATED (power-of-two size-class) free list: alloc and
//! free are O(1) — pop/push a per-class free list, carving a fresh block from a bump
//! pointer when a class is empty. This matters enormously: QuickJS makes thousands
//! of small alloc/free per frame (every matrix/array/temporary), and a first-fit
//! linked-list allocator's O(free-holes) cost made that ~1 ms PER ALLOCATION on the
//! emulated core (the dominant per-frame cost). O(1) classes fixed it (car3d 15 ->
//! 60 fps). Blocks recycle within their class, so a steady per-frame workload stops
//! growing the bump and runs entirely from the free lists.
//!
//! Single-threaded (the QuickJS worker), so `static mut` matches the existing style.

extern crate alloc;

use core::alloc::Layout;
use core::ptr;

use psp::sys;

// 32 power-of-two classes (16 B .. 2 GB) — covers any 32-bit PSP allocation.
const NCLASS: usize = 32;
const MIN_SHIFT: usize = 4; // smallest class = 16 bytes (>= a free-list next ptr)

static mut FREE: [*mut u8; NCLASS] = [ptr::null_mut(); NCLASS];
static mut BUMP: usize = 0;
static mut BUMP_END: usize = 0;
static mut INITED: bool = false;

/// Reserve the arena on first use: take most of the free partition in a single
/// kernel block, leaving a margin for the few remaining global-allocator users
/// (retained mesh/texture buffers in gfx3d, std collections in main/bridge).
unsafe fn ensure_init() {
    if INITED {
        return;
    }
    INITED = true;
    let free = sys::sceKernelMaxFreeMemSize() as usize;
    let margin = 4 * 1024 * 1024;
    let size = if free > margin + 1024 * 1024 { free - margin } else { free / 2 };
    if size == 0 {
        return;
    }
    let base = alloc::alloc::alloc(Layout::from_size_align_unchecked(size, 16)); // ONE kernel object
    if !base.is_null() {
        BUMP = base as usize;
        BUMP_END = BUMP + size;
    }
}

/// Smallest power-of-two class index whose block (2^c) holds `need` bytes.
#[inline]
fn class_of(need: usize) -> usize {
    let mut c = MIN_SHIFT;
    while (1usize << c) < need {
        c += 1;
    }
    c
}

/// Allocate `size` bytes aligned to `align` from the arena (null on OOM).
#[inline]
pub unsafe fn alloc(size: usize, align: usize) -> *mut u8 {
    ensure_init();
    if size == 0 || BUMP == 0 {
        return ptr::null_mut();
    }
    let a = if align < 16 { 16 } else { align };
    // Block must hold `size` AND be large enough that its natural alignment covers
    // `align` (blocks are `a`-aligned at carve, and a class block is reused as-is).
    let c = class_of(if size > a { size } else { a });
    if c >= NCLASS {
        return ptr::null_mut();
    }
    let head = FREE[c];
    if !head.is_null() {
        FREE[c] = *(head as *mut *mut u8); // pop: next-pointer is stored in the block
        return head;
    }
    // Carve a fresh 2^c block from the bump pointer, aligned to `a` (minimal waste).
    let p = (BUMP + a - 1) & !(a - 1);
    let np = p + (1usize << c);
    if np > BUMP_END {
        return ptr::null_mut();
    }
    BUMP = np;
    p as *mut u8
}

/// Free a pointer previously returned by `alloc` with the SAME size + align.
#[inline]
pub unsafe fn dealloc(p: *mut u8, size: usize, align: usize) {
    if p.is_null() || size == 0 {
        return;
    }
    let a = if align < 16 { 16 } else { align };
    let c = class_of(if size > a { size } else { a });
    if c >= NCLASS {
        return;
    }
    *(p as *mut *mut u8) = FREE[c]; // push: store the old head in the freed block
    FREE[c] = p;
}
