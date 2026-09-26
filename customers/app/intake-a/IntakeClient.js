'use client';
import LegacyPage from '../../components/LegacyPage';
import html from '../markup/intakeA';

const CSS = ['style.css', '../shared/offers.css'];
const SCRIPTS = ['../shared/api.js', '../shared/offers.js', 'script.js'];

export default function IntakeClient() {
  return <LegacyPage html={html} css={CSS} scripts={SCRIPTS} />;
}
