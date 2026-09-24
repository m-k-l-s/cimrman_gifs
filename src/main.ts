import { mount } from 'svelte';
import App from './App.svelte';
import { readTheme, setTheme } from './theme';
import './style.css';

setTheme(readTheme());
const target = document.getElementById('app')!;
target.replaceChildren();
mount(App, { target });
