declare module "fs-ext" {
  export function flock(fd: number, flags: number, callback: (error: NodeJS.ErrnoException | null) => void): void;
  export const constants: {
    readonly LOCK_EX: number;
    readonly LOCK_NB: number;
  };
}
