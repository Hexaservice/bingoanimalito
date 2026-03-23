// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyDFDwPoH0Gl6GO3O0gLVmcTtcaXsYgUSV0",
  authDomain: "bingoanimalito.firebaseapp.com",
  projectId: "bingoanimalito",
  storageBucket: "bingoanimalito.firebasestorage.app",
  messagingSenderId: "396029548802",
  appId: "1:396029548802:web:88c183bf7e1d7df9d60a1b",
  measurementId: "G-4BWBDZD0K5"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
