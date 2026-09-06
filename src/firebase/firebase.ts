import { initializeApp } from "firebase/app";
import {
    getMessaging,
    getToken,
    onMessage,
} from "firebase/messaging";

const firebaseConfig = {
    apiKey: "...",
    authDomain: "...",
    projectId: "...",
    storageBucket: "...",
    messagingSenderId: "...",
    appId: "...",
};

const app = initializeApp(firebaseConfig);

export const messaging = getMessaging(app);

export const requestNotificationPermission = async () => {
    try {
        const permission = await Notification.requestPermission();

        if (permission !== "granted") {
            return null;
        }

        const token = await getToken(messaging, {
            vapidKey: "YOUR_VAPID_KEY",
        });

        return token;
    } catch (err) {
        console.error(err);
        return null;
    }
};

export { onMessage };