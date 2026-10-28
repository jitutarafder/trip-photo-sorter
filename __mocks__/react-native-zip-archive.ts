export const zip = jest.fn().mockImplementation((source: string, target: string) => {
  return Promise.resolve(target);
});

export const unzip = jest.fn().mockImplementation((source: string, target: string) => {
  return Promise.resolve(target);
});

export const subscribe = jest.fn().mockReturnValue({ remove: jest.fn() });
export const isPasswordProtected = jest.fn().mockResolvedValue(false);
export const DEFAULT_COMPRESSION = -1;
export const NO_COMPRESSION = 0;
export const BEST_SPEED = 1;
export const BEST_COMPRESSION = 9;
