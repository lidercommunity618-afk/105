import { describe, it, expect, beforeEach } from 'vitest';
import { useApiKeysStore, getApiKey } from './useApiKeysStore';

describe('useApiKeysStore', () => {
  beforeEach(() => {
    useApiKeysStore.setState({ keys: { derivAppId: '' } });
    sessionStorage.clear();
  });

  it('starts with empty keys', () => {
    expect(useApiKeysStore.getState().keys.derivAppId).toBe('');
  });

  it('setKey updates the specified key', () => {
    useApiKeysStore.getState().setKey('derivAppId', '12345');
    expect(useApiKeysStore.getState().keys.derivAppId).toBe('12345');
  });

  it('setKey does not affect other keys', () => {
    useApiKeysStore.getState().setKey('derivAppId', '12345');
    const keys = useApiKeysStore.getState().keys;
    // Only derivAppId exists in the interface
    expect(Object.keys(keys)).toHaveLength(1);
  });

  it('getApiKey returns the value from the store', () => {
    useApiKeysStore.getState().setKey('derivAppId', 'my-app-id');
    expect(getApiKey('derivAppId')).toBe('my-app-id');
  });

  it('getApiKey returns empty string for unset key', () => {
    expect(getApiKey('derivAppId')).toBe('');
  });
});
