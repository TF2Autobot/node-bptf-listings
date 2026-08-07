import { EventEmitter } from 'events';
import SchemaManager from '@tf2autobot/tf2-schema';
import SteamID from 'steamid';
import Currencies from '@tf2autobot/tf2-currencies';

declare class ListingManager extends EventEmitter {
    static EFailiureReason: Record<string, unknown>;

    constructor(options?: {
        token?: string;
        steamid?: string;
        userAgent?: string;
        userID?: string;
        waitTime?: number;
        batchSize?: number;
        schema?: SchemaManager.Schema;
    });

    token: string | undefined;

    steamid: SteamID;

    waitTime: number;

    batchSize: number;

    cap: number | null;

    promotes: number | null;

    listings: ListingManager.Listing[];

    actions: { create: ListingManager.CreateListing[]; remove: string[] };

    ready: boolean;

    schema: SchemaManager.Schema | null;

    _timeout: ReturnType<typeof setTimeout>;

    _heartbeatInterval: ReturnType<typeof setInterval>;

    _inventoryInterval: ReturnType<typeof setInterval>;

    init(callback: (err: any) => void): void;

    setUserID(userID: string): void;

    registerUserAgent(
        callback: (
            err: any,
            body?: { status: string; current_time?: number; expire_at?: number; client?: string }
        ) => void
    ): void;

    stopUserAgent(callback: (err: any, body?: { status: string }) => void): void;

    getListings(onShutdown: boolean, callback: (err: any, body?: any) => any): void;

    findListing(search: string | number): ListingManager.Listing | null;

    findListings(sku: string): ListingManager.Listing[];

    createListing(listing: ListingManager.CreateListing): void;

    createListings(listings: ListingManager.CreateListing[]): void;

    updateListing(listingId: string, properties: ListingManager.UpdateListing): void;

    removeListing(listingId: string): void;

    removeListings(...listings: (string | ListingManager.Listing)[]): void;

    deleteAllListings(callback: (err: any, body?: any) => any): void;

    deleteAllListings(intent: number, callback: (err: any, body?: any) => any): void;

    shutdown(): void;

    _processActions: (callback: (err?: Error) => void) => void;

    on(event: 'ready', handler: () => void): this;

    on(event: 'listings', handler: (listings: ListingManager.Listing[]) => void): this;

    on(event: 'actions', handler: (actions: { create: Record<string, unknown>[]; remove: string[] }) => void): this;

    on(
        event: 'pulse',
        handler: (pulse: { status: string; current_time?: number; expire_at?: number; client?: string }) => void
    ): this;

    on(event: 'inventory', handler: (lastUpdated: number) => void): this;

    on(event: 'createListingsError', handler: (err: ListingManager.CustomError) => void): this;

    on(
        event: 'createListingsSuccessful',
        handler: (response: {
            created: number;
            archived: number;
            errors: ListingManager.ListingsSuccessfulError[];
        }) => void
    ): this;

    on(event: 'updateListingsError', handler: (err: ListingManager.CustomError) => void): this;

    on(
        event: 'updateListingsSuccessful',
        handler: (response: { updated: number; errors: ListingManager.ListingsSuccessfulError[] }) => void
    ): this;

    on(event: 'deleteListingsError', handler: (err: ListingManager.CustomError) => void): this;

    on(event: 'deleteListingsSuccessful', handler: (response: Record<string, unknown>) => void): this;

    on(event: 'massDeleteListingsError', handler: (err: ListingManager.CustomError) => void): this;

    on(event: 'massDeleteListingsSuccessful', handler: (response: Record<string, unknown>) => void): this;

    on(event: 'deleteArchivedListingError', handler: (err: ListingManager.CustomError) => void): this;

    on(event: 'deleteArchivedListingSuccessful', handler: (response: boolean) => void): this;

    on(event: 'massDeleteArchiveError', handler: (err: ListingManager.CustomError) => void): this;

    on(event: 'massDeleteArchiveSuccessful', handler: (response: Record<string, unknown>) => void): this;
}

declare namespace ListingManager {
    interface Item {
        defindex: number;
        quality: number;
        craftable?: boolean;
        killstreak?: number;
        australium?: boolean;
        effect?: number;
        festive?: boolean;
        paintkit?: number;
        wear?: number;
        quality2?: number;
        craftnumber?: number;
        crateseries?: number;
        target?: number;
        output?: number;
        outputQuality?: number;
    }

    interface CreateListing {
        id?: string;
        sku?: string;
        intent: 0 | 1;
        quantity?: number;
        details?: string;
        promoted?: 0 | 1;
        currencies: Currencies;
        time: number;
    }

    interface UpdateListing {
        details: string;
        currencies: Currencies;
    }

    interface CustomError {
        message: string;
        status: number;
        data: Record<string, any>;
    }

    interface ListingsSuccessfulError {
        listing: ListingData;
        error: ListingError;
    }

    interface ListingData {
        time: number;
        id: string;
        intent: number;
        promoted: number;
        details: string;
        currencies: Currencies;
        offers: number;
        buyout: number;
    }

    interface ListingError {
        message: string;
        request: ListingData;
    }

    export class Listing {
        id: string;

        appid: number;

        steamid: SteamID;

        intent: 0 | 1;

        item: Record<string, unknown>;

        sku: string;

        details: string;

        currencies: Currencies;

        offers: boolean;

        buyout: boolean;

        promoted: 0 | 1;

        created: number;

        bump: number;

        archived: boolean;

        status: string;

        v2: boolean;

        getSKU(): string;

        getItem(): Item;

        update(properties: {
            currencies?: Currencies;
            details?: string;
            // quantity?: number;
        }): void;

        remove(): void;
    }
}

export = ListingManager;
