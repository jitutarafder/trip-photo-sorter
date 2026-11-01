export const loadTensorflowModel = jest.fn().mockResolvedValue({
  run: jest.fn().mockResolvedValue([new Float32Array(128).fill(0.1).buffer]),
});

export const useTensorflowModel = jest.fn().mockReturnValue({
  model: {
    run: jest.fn().mockResolvedValue([new Float32Array(128).fill(0.1).buffer]),
  },
  state: 'loaded',
  error: undefined,
});
