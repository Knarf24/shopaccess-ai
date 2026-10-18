/**
 * SEC-01 pins (M2-3, second review finding 1). The approved exact contents of each client module excepted from SEC-01,
 * as the SHA-256 of the file's bytes. These values are written here after a person has read the file; they are never
 * computed from the file at test time. A change to an excepted module fails SEC-01 until that change has been reviewed
 * and its new value is written here deliberately, in the same reviewed diff.
 *
 * src/components/FocusOnArrival.tsx, inspected October 17, 2026: 23 lines, ASCII, LF line endings; the "use client"
 * directive, one import (React's useEffect), and only getElementById and focus.
 */
export const FOCUS_ON_ARRIVAL_SHA256 = "b7cb31f27522c26b08184eaee7779dccb4916341c2059f1a4a1c1d642f2ee68d";
