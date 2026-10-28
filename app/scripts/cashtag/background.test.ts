import browser from 'webextension-polyfill';
import { EXTENSION_MESSAGES } from '#shared/constants/messages';
import {
  createCashtagResponse,
  isAllowedCashtagSender,
  bindTickerWidgetEnabledBroadcasts,
} from './background';
import type { Controller } from './lib/types';

jest.mock('webextension-polyfill', () => ({
  runtime: {
    getURL: (path: string) => `chrome-extension://testid/${path}`,
    sendMessage: jest.fn().mockResolvedValue(undefined),
  },
  tabs: {
    create: jest.fn().mockResolvedValue({}),
    query: jest.fn().mockResolvedValue([]),
    sendMessage: jest.fn().mockResolvedValue(undefined),
  },
}));

const extensionId = 'testid';
const widgetUrl = `chrome-extension://${extensionId}/cashtag-widget.html?symbol=ETH`;
const xTab = { id: 1, url: 'https://x.com/home' } as chrome.tabs.Tab;

function sender(
  overrides: Partial<chrome.runtime.MessageSender>,
): chrome.runtime.MessageSender {
  return {
    id: extensionId,
    ...overrides,
  };
}

describe('isAllowedCashtagSender', () => {
  beforeEach(() => {
    Object.assign(chrome.runtime, {
      id: extensionId,
      getURL: (path: string) => `chrome-extension://${extensionId}/${path}`,
    });
  });

  it('allows data requests from the top-frame X content script', () => {
    expect(
      isAllowedCashtagSender(
        EXTENSION_MESSAGES.GET_DATA,
        sender({ frameId: 0, url: 'https://x.com/home' }),
      ),
    ).toBe(true);
  });

  it('allows enabled-state requests from X subframes', () => {
    expect(
      isAllowedCashtagSender(
        EXTENSION_MESSAGES.GET_X_WIDGET_ENABLED,
        sender({ frameId: 2, url: 'https://x.com/embed' }),
      ),
    ).toBe(true);
  });

  it('rejects enabled-state requests from another website', () => {
    expect(
      isAllowedCashtagSender(
        EXTENSION_MESSAGES.GET_X_WIDGET_ENABLED,
        sender({ frameId: 0, url: 'https://example.com/' }),
      ),
    ).toBe(false);
  });

  it('rejects data requests from another website or an X subframe', () => {
    expect(
      isAllowedCashtagSender(
        EXTENSION_MESSAGES.GET_DATA,
        sender({ frameId: 0, url: 'https://example.com/' }),
      ),
    ).toBe(false);
    expect(
      isAllowedCashtagSender(
        EXTENSION_MESSAGES.GET_DATA,
        sender({ frameId: 2, url: 'https://x.com/embed' }),
      ),
    ).toBe(false);
  });

  it('allows widget actions only from the widget frame', () => {
    expect(
      isAllowedCashtagSender(
        EXTENSION_MESSAGES.OPEN_EXTENSION,
        sender({ frameId: 1, tab: xTab, url: widgetUrl }),
      ),
    ).toBe(true);
    expect(
      isAllowedCashtagSender(
        EXTENSION_MESSAGES.SET_X_WIDGET_ENABLED,
        sender({ frameId: 1, tab: xTab, url: widgetUrl }),
      ),
    ).toBe(true);
  });

  it('rejects widget actions from other extension pages', () => {
    expect(
      isAllowedCashtagSender(
        EXTENSION_MESSAGES.OPEN_EXTENSION,
        sender({
          frameId: 1,
          tab: xTab,
          url: `chrome-extension://${extensionId}/home.html`,
        }),
      ),
    ).toBe(false);
  });

  it('rejects the widget frame when its parent tab is not X', () => {
    expect(
      isAllowedCashtagSender(
        EXTENSION_MESSAGES.OPEN_EXTENSION,
        sender({
          frameId: 1,
          tab: {
            id: 2,
            url: 'https://example.com/',
          } as chrome.tabs.Tab,
          url: widgetUrl,
        }),
      ),
    ).toBe(false);
  });

  it('allows CONSUME_PENDING_ROUTE from extension pages only', () => {
    expect(
      isAllowedCashtagSender(
        EXTENSION_MESSAGES.CONSUME_PENDING_ROUTE,
        sender({
          frameId: 0,
          url: `chrome-extension://${extensionId}/sidepanel.html`,
        }),
      ),
    ).toBe(true);
  });

  it('rejects CONSUME_PENDING_ROUTE from content scripts', () => {
    expect(
      isAllowedCashtagSender(
        EXTENSION_MESSAGES.CONSUME_PENDING_ROUTE,
        sender({
          frameId: 0,
          tab: xTab,
          url: 'https://x.com/home',
        }),
      ),
    ).toBe(false);
  });
});

describe('createCashtagResponse', () => {
  const caipAssetId = 'eip155:1/slip44:60';
  const swapHash =
    '#/cross-chain/swaps/prepare-bridge-page?to=eip155%3A1%2Fslip44%3A60';
  const widgetSender = sender({
    frameId: 1,
    tab: { ...xTab, windowId: 7 } as chrome.tabs.Tab,
    url: widgetUrl,
  });
  const openSwapMessage = {
    type: EXTENSION_MESSAGES.OPEN_EXTENSION,
    body: { page: 'swap', caipAssetId },
  };

  function getController(useExternalServices = true) {
    return {
      preferencesController: {
        state: {
          useExternalServices,
          preferences: { showTickerWidget: true, useSidePanelAsDefault: true },
        },
      },
      remoteFeatureFlagController: {
        state: { remoteFeatureFlags: { cashtagInjection: true } },
      },
      bridgeController: {
        setLocation: jest.fn(),
      },
    } satisfies Controller;
  }

  // A promise that never settles, standing in for a slow API call. Anything
  // awaited before the privileged open would leave the open uncalled.
  function pending() {
    return new Promise<void>(() => undefined);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(chrome.runtime, {
      id: extensionId,
      getURL: (path: string) => `chrome-extension://${extensionId}/${path}`,
      getManifest: () => ({}),
    });
  });

  afterEach(() => {
    delete (globalThis.chrome as { sidePanel?: unknown }).sidePanel;
    delete (globalThis.chrome as { action?: unknown }).action;
  });

  it('sets pending route entry before calling open', () => {
    const open = jest.fn().mockResolvedValue(undefined);
    Object.assign(globalThis.chrome, {
      sidePanel: { open },
    });

    createCashtagResponse(openSwapMessage, widgetSender, getController);

    expect(open).toHaveBeenCalledWith({ windowId: 7 });
  });

  it('does not await anything before calling open', async () => {
    const open = jest.fn().mockImplementation(() => {
      return Promise.resolve(undefined);
    });
    Object.assign(globalThis.chrome, {
      sidePanel: { open },
    });

    createCashtagResponse(openSwapMessage, widgetSender, getController);

    expect(open).toHaveBeenCalledWith({ windowId: 7 });
  });

  it('deletes pending route entry when open rejects', async () => {
    const open = jest.fn().mockRejectedValue(new Error('no gesture'));
    Object.assign(globalThis.chrome, {
      sidePanel: { open },
    });

    await createCashtagResponse(openSwapMessage, widgetSender, getController);

    expect(open).toHaveBeenCalledWith({ windowId: 7 });

    const consumeResponse = await createCashtagResponse(
      {
        type: EXTENSION_MESSAGES.CONSUME_PENDING_ROUTE,
        body: { windowId: 7 },
      },
      sender({ frameId: 0 }),
      getController,
    );

    expect(consumeResponse).toEqual({
      type: EXTENSION_MESSAGES.CONSUME_PENDING_ROUTE,
      body: { path: null, search: null },
    });
  });

  it('consumes pending route once and returns null after', async () => {
    const consumeMessage = {
      type: EXTENSION_MESSAGES.CONSUME_PENDING_ROUTE,
      body: { windowId: 7 },
    };

    const open = jest.fn().mockResolvedValue(undefined);
    Object.assign(globalThis.chrome, {
      sidePanel: { open },
    });

    await createCashtagResponse(openSwapMessage, widgetSender, getController);

    const firstResponse = await createCashtagResponse(
      consumeMessage,
      sender({ frameId: 0 }),
      getController,
    );
    expect(firstResponse).toEqual({
      type: EXTENSION_MESSAGES.CONSUME_PENDING_ROUTE,
      body: {
        path: '/cross-chain/swaps/prepare-bridge-page',
        search: '?to=eip155%3A1%2Fslip44%3A60',
      },
    });

    const secondResponse = await createCashtagResponse(
      consumeMessage,
      sender({ frameId: 0 }),
      getController,
    );
    expect(secondResponse).toEqual({
      type: EXTENSION_MESSAGES.CONSUME_PENDING_ROUTE,
      body: { path: null, search: null },
    });
  });

  it('isolates pending routes per window', async () => {
    const open = jest.fn().mockResolvedValue(undefined);
    Object.assign(globalThis.chrome, {
      sidePanel: { open },
    });

    const window7Sender = sender({
      frameId: 1,
      tab: { ...xTab, windowId: 7 } as chrome.tabs.Tab,
      url: widgetUrl,
    });
    const window8Sender = sender({
      frameId: 1,
      tab: { ...xTab, windowId: 8 } as chrome.tabs.Tab,
      url: widgetUrl,
    });

    await createCashtagResponse(openSwapMessage, window7Sender, getController);
    await createCashtagResponse(
      {
        type: EXTENSION_MESSAGES.OPEN_EXTENSION,
        body: { page: 'asset', caipAssetId },
      },
      window8Sender,
      getController,
    );

    const window7Response = await createCashtagResponse(
      {
        type: EXTENSION_MESSAGES.CONSUME_PENDING_ROUTE,
        body: { windowId: 7 },
      },
      sender({ frameId: 0 }),
      getController,
    );
    expect(window7Response).toMatchObject({
      body: { path: '/cross-chain/swaps/prepare-bridge-page' },
    });

    const window8Response = await createCashtagResponse(
      {
        type: EXTENSION_MESSAGES.CONSUME_PENDING_ROUTE,
        body: { windowId: 8 },
      },
      sender({ frameId: 0 }),
      getController,
    );
    expect(window8Response).toMatchObject({
      body: { path: expect.stringMatching(/^\/asset\//u) },
    });
  });

  it('returns null for expired pending route', async () => {
    const open = jest.fn().mockResolvedValue(undefined);
    Object.assign(globalThis.chrome, {
      sidePanel: { open },
    });

    const dateSpy = jest.spyOn(Date, 'now');
    dateSpy.mockReturnValue(1000);

    await createCashtagResponse(openSwapMessage, widgetSender, getController);

    dateSpy.mockReturnValue(1000 + 16_000);

    const consumeResponse = await createCashtagResponse(
      {
        type: EXTENSION_MESSAGES.CONSUME_PENDING_ROUTE,
        body: { windowId: 7 },
      },
      sender({ frameId: 0 }),
      getController,
    );

    expect(consumeResponse).toEqual({
      type: EXTENSION_MESSAGES.CONSUME_PENDING_ROUTE,
      body: { path: null, search: null },
    });

    dateSpy.mockRestore();
  });

  it('returns null when consuming with missing windowId', async () => {
    const consumeResponse = await createCashtagResponse(
      {
        type: EXTENSION_MESSAGES.CONSUME_PENDING_ROUTE,
        body: {},
      },
      sender({ frameId: 0 }),
      getController,
    );

    expect(consumeResponse).toEqual({
      type: EXTENSION_MESSAGES.CONSUME_PENDING_ROUTE,
      body: { path: null, search: null },
    });
  });

  it('returns null when consuming with non-number windowId', async () => {
    const consumeResponse = await createCashtagResponse(
      {
        type: EXTENSION_MESSAGES.CONSUME_PENDING_ROUTE,
        body: { windowId: 'not-a-number' },
      },
      sender({ frameId: 0 }),
      getController,
    );

    expect(consumeResponse).toEqual({
      type: EXTENSION_MESSAGES.CONSUME_PENDING_ROUTE,
      body: { path: null, search: null },
    });
  });

  it('does not enable the widget when Basic Functionality is disabled', async () => {
    const controller = getController(false);

    const response = await createCashtagResponse(
      { type: EXTENSION_MESSAGES.GET_X_WIDGET_ENABLED },
      sender({ frameId: 0, url: 'https://x.com/home' }),
      () => controller,
    );

    expect(response).toEqual({
      type: EXTENSION_MESSAGES.GET_X_WIDGET_ENABLED,
      body: { enabled: false },
    });
  });

  it('does not fetch widget data when Basic Functionality is disabled', async () => {
    const controller = getController(false);

    const response = await createCashtagResponse(
      {
        type: EXTENSION_MESSAGES.GET_DATA,
        body: { symbol: 'ETH', fields: ['priceHistory'] },
      },
      sender({ frameId: 0, url: 'https://x.com/home' }),
      () => controller,
    );

    expect(response).toEqual({
      type: EXTENSION_MESSAGES.GET_DATA,
      body: { asset: null, similar: [], priceHistory: null },
    });
  });

  it('opens the popup without awaiting setPopup first', () => {
    const openPopup = jest.fn().mockResolvedValue(undefined);
    Object.assign(globalThis.chrome, {
      action: { openPopup, setPopup: jest.fn(pending) },
    });

    createCashtagResponse(openSwapMessage, widgetSender, getController);

    expect(openPopup).toHaveBeenCalledTimes(1);
  });

  it('opens a tab when neither the side panel nor the popup API exists', async () => {
    await createCashtagResponse(openSwapMessage, widgetSender, getController);

    expect(browser.tabs.create).toHaveBeenCalledWith({
      url: `chrome-extension://${extensionId}/home.html${swapHash}`,
    });
  });

  it('sets bridge location to x_widget before opening swap route', async () => {
    const controller = getController();
    await createCashtagResponse(
      openSwapMessage,
      widgetSender,
      () => controller,
    );

    expect(controller.bridgeController?.setLocation).toHaveBeenCalledWith(
      'x_widget',
    );
  });
});

describe('bindTickerWidgetEnabledBroadcasts', () => {
  it('subscribes to preference and cashtagInjection flag changes', () => {
    const subscribe = jest.fn();
    bindTickerWidgetEnabledBroadcasts(
      () =>
        ({
          controllerMessenger: { subscribe },
        }) as unknown as Controller,
    );

    expect(subscribe.mock.calls.map((call) => call[0])).toEqual([
      'PreferencesController:stateChange',
      'RemoteFeatureFlagController:stateChange',
    ]);
  });
});
