import { saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { normalizeBookFolderState, serializeBookFolderState } from './BookFolders.js';


/** @readonly */
/** @enum {string} */
export const SORT = {
    /** Alphabetical by entry comment (title/memo) */
    ALPHABETICAL: 'alphabetical',
    /** According to prompt depth (position-depth-order) */
    PROMPT: 'prompt',
};
/** @readonly */
/** @enum {string} */
export const SORT_DIRECTION = {
    /** Alphabetical by entry comment (title/memo) */
    ASCENDING: 'ascending',
    /** According to prompt depth (position-depth-order) */
    DESCENDING: 'descending',
};

export class Settings {
    /**@type {Settings} */
    static #instance;
    static get instance() {
        if (!this.#instance) {
            this.#instance = new Settings();
        }
        return this.#instance;
    }
    /**@type {SORT} */
    sortLogic = SORT.ALPHABETICAL;
    /**@type {SORT_DIRECTION} */
    sortDirection = SORT_DIRECTION.ASCENDING;
    /**
     * Top-level lorebook folders. Keyed by lorebook name inside `books`.
     * This is extension state only and is never written into a lorebook file.
     * @type {ReturnType<typeof normalizeBookFolderState>}
     */
    bookFolders = null;

    constructor() {
        const saved = extension_settings.lorebookManager ?? extension_settings.wordInfoDrawer ?? {};
        Object.assign(this, saved);
        this.bookFolders = normalizeBookFolderState(saved.bookFolders);
        extension_settings.lorebookManager = this;
    }

    toJSON() {
        return {
            sortLogic: this.sortLogic,
            sortDirection: this.sortDirection,
            bookFolders: serializeBookFolderState(this.bookFolders),
        };
    }

    save() {
        saveSettingsDebounced();
    }
}
