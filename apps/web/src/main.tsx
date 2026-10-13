import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { FacultyPage, StudentPage } from './ExamPages';
import './styles.css';
import 'katex/dist/katex.min.css';
const Page = window.location.pathname.replace(/\/$/, '') === '/faculty' ? FacultyPage : window.location.pathname.replace(/\/$/, '') === '/student' ? StudentPage : App;
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><Page /></React.StrictMode>);
