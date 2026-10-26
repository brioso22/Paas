<?php
header('Content-Type: application/json');
echo json_encode([
    'ok' => true,
    'app' => 'php-app',
    'php' => PHP_VERSION,
    'pdo' => PDO::getAvailableDrivers(),
    'mbstring' => extension_loaded('mbstring'),
    'zip' => extension_loaded('zip'),
    'path' => $_SERVER['REQUEST_URI'] ?? '/',
]);
