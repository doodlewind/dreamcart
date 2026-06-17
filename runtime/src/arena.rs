//! A single-arena sub-allocator for QuickJS + newlib `malloc`.
//!
//! rust-psp's global allocator (`alloc_impl.rs`) calls `sceKernelAllocPartitionMemory`
//! for EVERY allocation — i.e. one kernel object per allocation. The PSP kernel
//! caps the number of objects (~4096 in PPSSPP), and QuickJS makes many thousands
//! of small allocations evaluating a large bundle (the baked-asset games), so it
//! exhausts the slots; the un-checked allocator then writes to a null block head
//! and the guest jumps to a bad address (the `0x300000000` crash).
//!
//! Fix: grab ONE big block from the kernel up front and sub-allocate from it with
//! a free-list heap. Every QuickJS / C `malloc` then comes from this arena and
//! consumes ZERO additional kernel objects. Single-threaded (the QuickJS worker),
//! so a `static mut` heap matches the existing `qjs_alloc`/`c_heap` style.

extern crate alloc;

use core::alloc::Layout;
use core::ptr::{self, NonNull};

use linked_list_allocator::Heap;
use psp::sys;

// `Heap::empty()` is not const in 0.9.1, so wrap in an Option initialized lazily.
static mut HEAP: Option<Heap> = None;
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
    // Leave headroom so retained mesh/texture uploads (each a kernel block via the
    // global allocator) and the OS still have partition memory.
    let margin = 4 * 1024 * 1024;
    let size = if free > margin + 1024 * 1024 { free - margin } else { free / 2 };
    if size == 0 {
        return;
    }
    let layout = Layout::from_size_align_unchecked(size, 16);
    let base = alloc::alloc::alloc(layout); // ONE kernel object
    if !base.is_null() {
        let mut h = Heap::empty();
        h.init(base as usize, size); // 0.9.1 takes a usize address
        HEAP = Some(h);
    }
}

/// Allocate `size` bytes aligned to `align` from the arena (null on OOM).
#[inline]
pub unsafe fn alloc(size: usize, align: usize) -> *mut u8 {
    ensure_init();
    if size == 0 {
        return ptr::null_mut();
    }
    let layout = Layout::from_size_align_unchecked(size, if align == 0 { 1 } else { align });
    match HEAP.as_mut() {
        Some(h) => match h.allocate_first_fit(layout) {
            Ok(nn) => nn.as_ptr(),
            Err(_) => ptr::null_mut(),
        },
        None => ptr::null_mut(),
    }
}

/// Free a pointer previously returned by `alloc` with the SAME size + align.
#[inline]
pub unsafe fn dealloc(p: *mut u8, size: usize, align: usize) {
    if p.is_null() || size == 0 {
        return;
    }
    let layout = Layout::from_size_align_unchecked(size, if align == 0 { 1 } else { align });
    if let Some(h) = HEAP.as_mut() {
        h.deallocate(NonNull::new_unchecked(p), layout);
    }
}
