export const ColorType = {
  RGBA_8888: 4,
};

export const AlphaType = {
  Unpremul: 3,
};

export const Skia = {
  Data: {
    fromBase64: jest.fn(() => ({})),
  },
  Image: {
    MakeImageFromEncoded: jest.fn(() => ({
      makeNonTextureImage: () => ({
        width: () => 112,
        height: () => 112,
        readPixels: () => new Uint8Array(112 * 112 * 4),
      }),
    })),
  },
};
