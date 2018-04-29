import { HttpsCallableResult, HttpsError } from '@firebase/functions-types';
import { replace, LOCATION_CHANGED } from '@mraerino/redux-little-router-reactless';
import { delay } from 'redux-saga';
import { all, apply, call, put, select, take, takeEvery, takeLatest } from 'redux-saga/effects';

import { CLIENT_ID } from '../../spotify.config';
import { showToast, Types } from '../actions';
import { exchangeCodeFail, exchangeCodeFinish, exchangeCodeStart, notifyAuthStatusKnown } from '../actions/auth';
import { State } from '../state';
import { requireAuth, AuthData } from '../util/auth';
import firebase from '../util/firebase';
import { fetchWithAccessToken, LOCALSTORAGE_KEY, SCOPES } from '../util/spotify-auth';

const AUTH_REDIRECT_LOCAL_STORAGE_KEY = 'authRedirect';
const exchangeCodeFn = firebase.functions!().httpsCallable('exchangeCode');

function* checkSpotifyLoginStatus() {
    if (!localStorage[LOCALSTORAGE_KEY]) {
        yield put(notifyAuthStatusKnown('spotify', null));
        return;
    }

    try {
        const resp = yield call(fetchWithAccessToken, '/me');
        const user = yield resp.json();

        yield put(notifyAuthStatusKnown('spotify', user));
    } catch (err) {
        console.error('Failed to fetch Spotify Login Status.');
        return;
    }
}

function* exchangeCode() {
    const action = yield take(LOCATION_CHANGED);
    const { code, error, state } = action.payload.query;

    if (state !== 'SPOTIFY_AUTH') {
        return;
    }

    yield put(exchangeCodeStart());

    if (error === 'access_denied') {
        const e = new Error('Oops, Spotify denied access.');
        yield put(exchangeCodeFail(e));
        return;
    }

    yield put(replace(localStorage[AUTH_REDIRECT_LOCAL_STORAGE_KEY] || '/', {}));
    localStorage.removeItem(AUTH_REDIRECT_LOCAL_STORAGE_KEY);

    const { currentUser } = firebase.auth!();

    let resp: HttpsCallableResult;
    try {
        resp = yield call(exchangeCodeFn, {
            callbackUrl: location.origin,
            code,
            userToken: currentUser ? yield currentUser.getIdToken(true) : undefined,
        });
    } catch (err) {
        const e = ((err as HttpsError).code === 'invalid-argument')
            ? err // In this case the error message is suitable for displaying to the user
            : new Error(`Token exchange failed with ${err.code}: ${err.message}.`);
        yield put(exchangeCodeFail(e));
        return;
    }
    const { accessToken, expiresIn, firebaseToken, refreshToken } = resp.data;

    yield call(requireAuth);

    const data = new AuthData(
        accessToken,
        Date.now() + (expiresIn * 1000),
        refreshToken,
    );

    yield apply(data, data.saveTo, [LOCALSTORAGE_KEY]);
    yield* checkSpotifyLoginStatus();

    const { user }: State = yield select();

    if (!user.spotify.user) {
        yield put(exchangeCodeFail(new Error('Spotify user is not set.')));
        yield apply(data, data.remove, [LOCALSTORAGE_KEY]);
        return;
    }

    yield firebase.auth!().signInWithCustomToken(firebaseToken);

    yield put(exchangeCodeFinish());

    const welcomeText = user.spotify.user
        ? `Welcome, ${user.spotify.user.display_name || user.spotify.user.id}!`
        : 'Welcome!';
    yield put(showToast(welcomeText));
}

const oauthUrl = `https://accounts.spotify.com/authorize?client_id=${CLIENT_ID}`
    + `&redirect_uri=${encodeURIComponent(window.location.origin)}&response_type=code`
    + `&scope=${encodeURIComponent(SCOPES.join(' '))}&state=SPOTIFY_AUTH&show_dialog=true`;

function* triggerOAuthLogin() {
    localStorage[AUTH_REDIRECT_LOCAL_STORAGE_KEY] =
        window.location.pathname + window.location.search + window.location.hash;
    yield call(console.log, 'Only the swaggiest of developers hacking on Festify will see this 🙌.');
    window.location.href = oauthUrl;
}

/**
 * This saga forcefully refreshes the user token every 55 minutes
 * to prevent Firebase from disconnecting and thus destroying playback.
 */
function* refreshFirebaseAuth() {
    while (true) {
        yield call(delay, 1000 * 60 * 55);

        const { currentUser } = firebase.auth!();
        if (!currentUser) {
            continue;
        }

        // Retry five times
        for (let i = 0; i < 5; i++) {
            try {
                yield apply(currentUser, currentUser.getIdToken, [true]);
                break;
            } catch (err) {
                const duration = 5000 * i;
                console.warn(`Failed to forcefully reauth user, trying again after ${duration / 1000}s.`, err);
                yield call(delay, duration);
            }
        }
    }
}

export default function*() {
    yield all([
        takeEvery(Types.CHECK_SPOTIFY_LOGIN_STATUS, checkSpotifyLoginStatus),
        takeLatest(Types.TRIGGER_SPOTIFY_OAUTH_LOGIN, triggerOAuthLogin),
        exchangeCode(),
        refreshFirebaseAuth(),
    ]);
}
