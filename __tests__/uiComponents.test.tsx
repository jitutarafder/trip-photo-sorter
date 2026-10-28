import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { Text } from 'react-native';
import {
  Button,
  TextField,
  Banner,
  EmptyState,
  Skeleton,
  ProgressRing,
} from '../src/components/ui';

describe('UI Base Components (Task 3.1, 03_UI_Spec)', () => {
  describe('Button', () => {
    it('renders with title and fires onPress', async () => {
      const onPressMock = jest.fn();
      const { getByText } = await render(
        <Button title="Click Me" onPress={onPressMock} />
      );

      const buttonText = getByText('Click Me');
      expect(buttonText).toBeTruthy();

      fireEvent.press(buttonText);
      expect(onPressMock).toHaveBeenCalledTimes(1);
    });

    it('renders all variants without crashing', async () => {
      const { getByText } = await render(
        <>
          <Button title="Primary" variant="primary" />
          <Button title="Secondary" variant="secondary" />
          <Button title="Ghost" variant="ghost" />
          <Button title="Danger" variant="danger" />
        </>
      );

      expect(getByText('Primary')).toBeTruthy();
      expect(getByText('Secondary')).toBeTruthy();
      expect(getByText('Ghost')).toBeTruthy();
      expect(getByText('Danger')).toBeTruthy();
    });

    it('renders all sizes (sm, md, lg)', async () => {
      const { getByText } = await render(
        <>
          <Button title="Small" size="sm" />
          <Button title="Medium" size="md" />
          <Button title="Large" size="lg" />
        </>
      );

      expect(getByText('Small')).toBeTruthy();
      expect(getByText('Medium')).toBeTruthy();
      expect(getByText('Large')).toBeTruthy();
    });

    it('does not fire onPress when disabled', async () => {
      const onPressMock = jest.fn();
      const { getByRole } = await render(
        <Button title="Disabled" disabled onPress={onPressMock} />
      );

      const button = getByRole('button');
      fireEvent.press(button);
      expect(onPressMock).not.toHaveBeenCalled();
    });

    it('displays loading spinner and ignores onPress when loading', async () => {
      const onPressMock = jest.fn();
      const { getByTestId, queryByText } = await render(
        <Button title="Saving" loading testID="save-btn" onPress={onPressMock} />
      );

      expect(getByTestId('save-btn-spinner')).toBeTruthy();
      expect(queryByText('Saving')).toBeNull();

      fireEvent.press(getByTestId('save-btn'));
      expect(onPressMock).not.toHaveBeenCalled();
    });

    it('renders left and right icons', async () => {
      const { getByText } = await render(
        <Button
          title="With Icon"
          icon={<Text testID="left-icon">★</Text>}
          iconPosition="left"
        />
      );

      expect(getByText('★')).toBeTruthy();
      expect(getByText('With Icon')).toBeTruthy();
    });
  });

  describe('TextField', () => {
    it('renders placeholder, label, and responds to text changes', async () => {
      const onChangeMock = jest.fn();
      const { getByPlaceholderText, getByText } = await render(
        <TextField
          label="Trip Name"
          placeholder="Enter trip name"
          value="Cox's Bazar"
          onChangeText={onChangeMock}
        />
      );

      expect(getByText('Trip Name')).toBeTruthy();
      const input = getByPlaceholderText('Enter trip name');
      expect(input.props.value).toBe("Cox's Bazar");

      fireEvent.changeText(input, 'Sylhet Tour');
      expect(onChangeMock).toHaveBeenCalledWith('Sylhet Tour');
    });

    it('displays error message when error prop is provided', async () => {
      const { getByTestId, getByText } = await render(
        <TextField
          testID="name-input"
          value=""
          error="Name is required"
        />
      );

      expect(getByTestId('name-input-error')).toBeTruthy();
      expect(getByText('Name is required')).toBeTruthy();
    });

    it('displays helper text when no error exists', async () => {
      const { getByText } = await render(
        <TextField
          value=""
          helperText="Max 40 characters"
        />
      );

      expect(getByText('Max 40 characters')).toBeTruthy();
    });

    it('clears text when clear button is clicked', async () => {
      const onChangeMock = jest.fn();
      const { getByTestId } = await render(
        <TextField
          testID="clearable-input"
          value="Some text"
          clearable
          onChangeText={onChangeMock}
        />
      );

      const clearBtn = getByTestId('clearable-input-clear');
      expect(clearBtn).toBeTruthy();

      fireEvent.press(clearBtn);
      expect(onChangeMock).toHaveBeenCalledWith('');
    });
  });

  describe('Banner', () => {
    it('renders message and title in info variant', async () => {
      const { getByText } = await render(
        <Banner
          title="Syncing"
          message="Scanning your photos for trips."
          variant="info"
        />
      );

      expect(getByText('Syncing')).toBeTruthy();
      expect(getByText('Scanning your photos for trips.')).toBeTruthy();
    });

    it('renders warning, error, and success variants without crashing', async () => {
      const { getByText } = await render(
        <>
          <Banner variant="warning" message="Storage low" />
          <Banner variant="error" message="Scan failed" />
          <Banner variant="success" message="Export complete" />
        </>
      );

      expect(getByText('Storage low')).toBeTruthy();
      expect(getByText('Scan failed')).toBeTruthy();
      expect(getByText('Export complete')).toBeTruthy();
    });

    it('handles action button press', async () => {
      const onActionMock = jest.fn();

      const { getByTestId, getByText } = await render(
        <Banner
          testID="test-banner"
          message="Limited access granted"
          action={{ label: 'Manage', onPress: onActionMock }}
        />
      );

      expect(getByText('Manage')).toBeTruthy();
      fireEvent.press(getByTestId('test-banner-action'));
      expect(onActionMock).toHaveBeenCalledTimes(1);
    });

    it('handles dismiss button press', async () => {
      const onDismissMock = jest.fn();

      const { getByTestId } = await render(
        <Banner
          testID="test-banner"
          message="Limited access granted"
          onDismiss={onDismissMock}
        />
      );

      fireEvent.press(getByTestId('test-banner-dismiss'));
      expect(onDismissMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('EmptyState', () => {
    it('renders title, body, and action button', async () => {
      const onActionMock = jest.fn();
      const { getByText, getByTestId } = await render(
        <EmptyState
          testID="empty-trips"
          icon={<Text testID="empty-icon">🏖️</Text>}
          title="No trips found yet"
          body="Take 15+ photos over 3 hours to detect your first trip."
          actionTitle="Rescan Library"
          onActionPress={onActionMock}
        />
      );

      expect(getByTestId('empty-trips')).toBeTruthy();
      expect(getByText('🏖️')).toBeTruthy();
      expect(getByText('No trips found yet')).toBeTruthy();
      expect(getByText('Take 15+ photos over 3 hours to detect your first trip.')).toBeTruthy();

      const actionButton = getByText('Rescan Library');
      expect(actionButton).toBeTruthy();

      fireEvent.press(actionButton);
      expect(onActionMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('Skeleton', () => {
    it('renders rectangular skeleton with custom dimensions', async () => {
      const { getByTestId } = await render(
        <Skeleton testID="card-skeleton" width={200} height={40} borderRadius={8} />
      );

      const skeleton = getByTestId('card-skeleton');
      expect(skeleton).toBeTruthy();
    });

    it('renders circular skeleton', async () => {
      const { getByTestId } = await render(
        <Skeleton testID="avatar-skeleton" width={60} circle />
      );

      const skeleton = getByTestId('avatar-skeleton');
      expect(skeleton).toBeTruthy();
    });
  });

  describe('ProgressRing', () => {
    it('renders indeterminate spinning ring when progress is undefined', async () => {
      const { getByTestId } = await render(
        <ProgressRing testID="progress" />
      );

      expect(getByTestId('progress-indeterminate')).toBeTruthy();
    });

    it('renders determinate ring with progress percentage text', async () => {
      const { getByTestId, getByText } = await render(
        <ProgressRing
          testID="determinate-progress"
          progress={0.75}
          showPercentText
        />
      );

      expect(getByTestId('determinate-progress-determinate')).toBeTruthy();
      expect(getByText('75%')).toBeTruthy();
    });

    it('renders custom center text', async () => {
      const { getByText } = await render(
        <ProgressRing
          progress={0.5}
          centerText="50/100"
        />
      );

      expect(getByText('50/100')).toBeTruthy();
    });
  });
});
