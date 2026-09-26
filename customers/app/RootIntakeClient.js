'use client';
import LegacyPage from '../components/LegacyPage';
import html from './markup/root';

const CSS = ['style.css?v=8', 'shared/offers.css'];
const SCRIPTS = ['shared/api.js', 'shared/offers.js', 'script.js?v=7'];

export default function RootIntakeClient() {
  return <LegacyPage html={html} css={CSS} scripts={SCRIPTS} />;
}
