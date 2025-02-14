import { jest } from '@jest/globals';

import { Context } from '../src/context';
import { handleTokenRequest, default as workerObject } from '../src/index';
import { IssuerConfigurationResponse } from '../src/types';
import { b64ToB64URL, u8ToB64 } from '../src/utils/base64';
import { ExecutionContextMock, MockCache, getContext, getEnv } from './mocks';
import { RSABSSA } from '@cloudflare/blindrsa-ts';
import {
	MediaType,
	PRIVATE_TOKEN_ISSUER_DIRECTORY,
	publicVerif,
	util,
} from '@cloudflare/privacypass-ts';
import { getDirectoryCache } from '../src/cache';
const { TokenRequest } = publicVerif;

const sampleURL = 'http://localhost';

const keyToTokenKeyID = async (key: Uint8Array): Promise<number> => {
	const hash = await crypto.subtle.digest('SHA-256', key);
	const u8 = new Uint8Array(hash);
	return u8[u8.length - 1];
};

describe('challenge handlers', () => {
	const suite = RSABSSA.SHA384.PSS.Deterministic();

	const tokenRequestURL = `${sampleURL}/token-request`;
	const mockPrivateKey = async (ctx: Context): Promise<CryptoKeyPair> => {
		const keypair = await suite.generateKey({
			publicExponent: Uint8Array.from([1, 0, 1]),
			modulusLength: 2048,
		});
		const publicKey = new Uint8Array(
			(await crypto.subtle.exportKey('spki', keypair.publicKey)) as ArrayBuffer
		);
		const publicKeyEnc = b64ToB64URL(u8ToB64(util.convertEncToRSASSAPSS(publicKey)));
		const tokenKey = await keyToTokenKeyID(new TextEncoder().encode(publicKeyEnc));
		await ctx.env.ISSUANCE_KEYS.put(
			tokenKey.toString(),
			(await crypto.subtle.exportKey('pkcs8', keypair.privateKey)) as ArrayBuffer,
			{ customMetadata: { publicKey: publicKeyEnc } }
		);
		return keypair;
	};

	it('should return a Privacy Pass token response when provided with a valid Privacy Pass token request', async () => {
		const ctx = getContext({ env: getEnv(), ectx: new ExecutionContextMock() });

		const msgString = 'Hello World!';
		const message = new TextEncoder().encode(msgString);
		const preparedMsg = suite.prepare(message);
		const { publicKey } = await mockPrivateKey(ctx);
		const { blindedMsg, inv } = await suite.blind(publicKey, preparedMsg);
		const publicKeyExport = new Uint8Array(
			(await crypto.subtle.exportKey('spki', publicKey)) as ArrayBuffer
		);
		const publicKeyU8 = util.convertEncToRSASSAPSS(publicKeyExport);
		const publicKeyEnc = b64ToB64URL(u8ToB64(publicKeyU8));
		const tokenKeyId = await keyToTokenKeyID(new TextEncoder().encode(publicKeyEnc));

		// note that blindedMsg should be the payload and not the message directly
		const tokenRequest = new TokenRequest(tokenKeyId, blindedMsg);

		const request = new Request(tokenRequestURL, {
			method: 'POST',
			headers: { 'content-type': MediaType.PRIVATE_TOKEN_REQUEST },
			body: tokenRequest.serialize(),
		});

		const response = await handleTokenRequest(ctx, request);

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe(MediaType.PRIVATE_TOKEN_RESPONSE);

		const blindSignature = new Uint8Array(await response.arrayBuffer());
		const signature = await suite.finalize(publicKey, preparedMsg, blindSignature, inv);
		const isValid = await suite.verify(publicKey, signature, preparedMsg);
		expect(isValid).toBe(true);
	});
});

describe('non existing handler', () => {
	const nonExistingURL = `${sampleURL}/non-existing`;

	it('should return 404 when a non GET existing endpoint is requested', async () => {
		const request = new Request(nonExistingURL);
		const response = await workerObject.fetch(request, getEnv(), new ExecutionContextMock());

		expect(response.status).toBe(404);
	});

	it('should return 404 when a non POST existing endpoint is requested', async () => {
		const request = new Request(nonExistingURL, { method: 'POST' });
		const response = await workerObject.fetch(request, getEnv(), new ExecutionContextMock());

		expect(response.status).toBe(404);
	});
});

describe('rotate and clear key', () => {
	const rotateURL = `${sampleURL}/admin/rotate`;
	const clearURL = `${sampleURL}/admin/clear`;
	const directoryURL = `${sampleURL}${PRIVATE_TOKEN_ISSUER_DIRECTORY}`;

	it('should generate multiple keys', async () => {
		const rotateRequest = new Request(rotateURL, { method: 'POST' });
		const directoryRequest = new Request(directoryURL);

		const NUMBER_OF_KEYS_GENERATED = 3;
		for (let i = 0; i < NUMBER_OF_KEYS_GENERATED; i += 1) {
			await workerObject.fetch(rotateRequest, getEnv(), new ExecutionContextMock());
		}

		const response = await workerObject.fetch(
			directoryRequest,
			getEnv(),
			new ExecutionContextMock()
		);
		expect(response.ok).toBe(true);

		const directory: IssuerConfigurationResponse = await response.json();
		expect(directory['token-keys']).toHaveLength(NUMBER_OF_KEYS_GENERATED);
	});

	it('should clear keys and keep only one', async () => {
		const rotateRequest = new Request(rotateURL, { method: 'POST' });
		const clearRequest = new Request(clearURL, { method: 'POST' });
		const directoryRequest = new Request(directoryURL);

		const NUMBER_OF_KEYS_GENERATED = 3;
		for (let i = 0; i < NUMBER_OF_KEYS_GENERATED; i += 1) {
			await workerObject.fetch(rotateRequest, getEnv(), new ExecutionContextMock());
		}
		await workerObject.fetch(clearRequest, getEnv(), new ExecutionContextMock());

		let response = await workerObject.fetch(directoryRequest, getEnv(), new ExecutionContextMock());
		expect(response.ok).toBe(true);

		let directory: IssuerConfigurationResponse = await response.json();
		expect(directory['token-keys']).toHaveLength(1);

		// repeated clear should keep one key
		await workerObject.fetch(clearRequest, getEnv(), new ExecutionContextMock());
		response = await workerObject.fetch(directoryRequest, getEnv(), new ExecutionContextMock());
		expect(response.ok).toBe(true);

		directory = await response.json();
		expect(directory['token-keys']).toHaveLength(1);
	});
});

describe('cache directory response', () => {
	const rotateURL = `${sampleURL}/admin/rotate`;
	const directoryURL = `${sampleURL}${PRIVATE_TOKEN_ISSUER_DIRECTORY}`;

	const initializeKeys = async (numberOfKeys = 1): Promise<void> => {
		const rotateRequest = new Request(rotateURL, { method: 'POST' });

		for (let i = 0; i < numberOfKeys; i += 1) {
			await workerObject.fetch(rotateRequest, getEnv(), new ExecutionContextMock());
		}
	};

	it('should cache the directory response', async () => {
		await initializeKeys();

		const mockCaches: Map<string, MockCache> = new Map();
		const spy = jest.spyOn(caches, 'open').mockImplementation(async (name: string) => {
			if (!mockCaches.has(name)) {
				mockCaches.set(name, new MockCache());
			}
			return mockCaches.get(name) as unknown as Cache;
		});
		const directoryRequest = new Request(directoryURL);
		const mockCache = (await getDirectoryCache()) as unknown as MockCache;

		let response = await workerObject.fetch(directoryRequest, getEnv(), new ExecutionContextMock());
		expect(response.ok).toBe(true);
		expect(Object.entries(mockCache.cache)).toHaveLength(1);

		const [cachedURL, _] = Object.entries(mockCache.cache)[0];
		const sampleEtag = '"sampleEtag"';
		const cachedResponse = new Response('cached response', { headers: { etag: sampleEtag } });
		mockCache.cache[cachedURL] = cachedResponse;

		response = await workerObject.fetch(directoryRequest, getEnv(), new ExecutionContextMock());
		expect(response.ok).toBe(true);
		expect(response).toBe(cachedResponse);

		const cachedDirectoryRequest = new Request(directoryURL, {
			headers: { 'if-none-match': sampleEtag },
		});
		response = await workerObject.fetch(
			cachedDirectoryRequest,
			getEnv(),
			new ExecutionContextMock()
		);
		expect(response.status).toBe(304);

		const headCachedDirectoryRequest = new Request(directoryURL, {
			method: 'HEAD',
			headers: { 'if-none-match': sampleEtag },
		});
		response = await workerObject.fetch(
			headCachedDirectoryRequest,
			getEnv(),
			new ExecutionContextMock()
		);
		expect(response.status).toBe(304);

		spy.mockClear();
	});
});
